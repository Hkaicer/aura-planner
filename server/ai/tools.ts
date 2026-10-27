// Structured, validated tools exposed to the Claude agent.
//
// The model never touches the database. Each call is validated with zod,
// executed by the same domain functions the UI uses, and applied to a private
// overlay of the data. Write tools only *stage* changes; the agent orchestrator
// turns the staged changes into a proposal the user can review.

import { z } from "zod";
import type { Task } from "../../shared/schemas";
import { zDate, zEnergy, zEventKind, zIntensity, zPlanMode, zPriority, zRecurrence, zTime } from "../../shared/schemas";
import { addDays, combine, fromMinutes, isValidDateTime, timeOf, zonedNow } from "../../shared/time";
import { OverlayStore } from "../db/store";
import { DomainError, localNow, type DomainContext } from "../domain/context";
import {
  addMemory,
  createEvent,
  createProject,
  deleteEvent,
  eventsBetween,
  findProjectByName,
  patchDayPlan,
  removeMemory,
  updateEvent,
  updateProject,
} from "../domain/entities";
import {
  analyze,
  applyPlan,
  completionStreak,
  computePlan,
  dayView,
  distributeTasks,
  findFreeTime,
  postponeTasks,
  suggestDay,
} from "../domain/planning";
import {
  completeTask,
  createTask,
  deleteTask,
  editSubtasks,
  getTask,
  isOpen,
  isTemplate,
  moveTask,
  reopenTask,
  scheduleTask,
  setDependency,
  unscheduleTask,
  updateTask,
} from "../domain/tasks";
import type { PlanResult } from "../scheduling/engine";

export interface ToolCallRecord {
  name: string;
  ok: boolean;
  error?: string;
}

export interface RunContext {
  id: string;
  token: string;
  overlay: OverlayStore;
  ctx: DomainContext;
  readOnly: boolean;
  toolCalls: ToolCallRecord[];
  plans: PlanResult[];
  maxToolCalls: number;
  closed: boolean;
  onTool?: (record: ToolCallRecord) => void;
}

interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: S;
  write: boolean;
  run: (rc: RunContext, input: z.output<S>) => unknown;
}

function tool<S extends z.ZodType>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

// ---------------------------------------------------------------------------
// Compact representations returned to the model
// ---------------------------------------------------------------------------

function projectName(ctx: DomainContext, id: string | null): string | null {
  if (!id) return null;
  return ctx.store.get("project", id)?.name ?? null;
}

export function taskBrief(ctx: DomainContext, t: Task) {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    estimateMin: t.estimateMin,
    plannedDate: t.plannedDate,
    start: t.scheduledStart ? timeOf(t.scheduledStart) : null,
    end: t.scheduledEnd ? timeOf(t.scheduledEnd) : null,
    pinned: t.pinned || undefined,
    dueAt: t.dueAt,
    dueHard: t.dueAt ? t.dueHard : undefined,
    energy: t.energy !== "medium" ? t.energy : undefined,
    project: projectName(ctx, t.projectId),
    dependsOn: t.dependsOn.length ? t.dependsOn : undefined,
    subtasks: t.subtasks.length ? `${t.subtasks.filter((s) => s.done).length}/${t.subtasks.length}` : undefined,
    recurring: t.recurrenceParentId ? true : undefined,
    postponed: t.postponedCount || undefined,
  };
}

function planSummary(ctx: DomainContext, result: PlanResult) {
  const tomorrow = addDays(result.date, 1);
  return {
    date: result.date,
    mode: result.mode,
    status: result.stats.status,
    availableMin: result.stats.availableMin,
    scheduledMin: result.stats.scheduledMin,
    freeMinLeft: result.stats.freeMin,
    schedule: result.placements.map((p) => ({
      taskId: p.taskId,
      title: p.title,
      start: fromMinutes(p.start),
      end: fromMinutes(p.end),
      moved: p.moved,
    })),
    breaks: result.breaks.map((b) => `${fromMinutes(b.start)}–${fromMinutes(b.end)}`),
    lunch: result.lunch ? `${fromMinutes(result.lunch.start)}–${fromMinutes(result.lunch.end)}` : null,
    doesNotFit: result.overflow.map((o) => {
      const t = ctx.store.get("task", o.taskId);
      return {
        taskId: o.taskId,
        title: o.title,
        reason: o.reason,
        detail: o.detail,
        estimateMin: o.estimateMin,
        suggestedDate: t ? suggestDay(ctx, t, tomorrow) : null,
      };
    }),
    explanation: result.explanation,
    warnings: result.warnings,
  };
}

function resolveProject(ctx: DomainContext, ref: string | null | undefined): string | null | undefined {
  if (ref === undefined) return undefined;
  if (ref === null || ref === "") return null;
  if (ctx.store.get("project", ref)) return ref;
  const byName = findProjectByName(ctx, ref);
  if (byName) return byName.id;
  const names = ctx.store
    .all("project")
    .map((p) => `"${p.name}" (${p.id})`)
    .join(", ");
  throw new DomainError("validation", `Unknown project "${ref}". Existing projects: ${names || "none"}. Create it first with create_project.`);
}

/** Accepts "YYYY-MM-DD" (end of day) or "YYYY-MM-DDTHH:mm". */
const zDue = z
  .string()
  .refine((v) => /^\d{4}-\d{2}-\d{2}$/.test(v) || isValidDateTime(v), { message: "Use YYYY-MM-DD or YYYY-MM-DDTHH:mm" })
  .transform((v) => (v.length === 10 ? `${v}T23:59` : v));

const zMinutes = z.number().int().min(5).max(720);

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const TOOLS = [
  // ---- read -------------------------------------------------------------
  tool({
    name: "get_day",
    description:
      "Read one day: planning window, fixed events, tasks with times, flexible tasks, overdue tasks, workload status (ok/tight/overloaded), conflicts and progress. Defaults to today.",
    input: z.object({ date: zDate.optional() }),
    write: false,
    run: (rc, i) => {
      const date = i.date ?? localNow(rc.ctx).date;
      const v = dayView(rc.ctx, date);
      return {
        date,
        now: v.now,
        window: v.window,
        intensity: v.plan.intensity,
        events: v.events.map((e) => ({ id: e.id, title: e.title, start: e.start, end: e.end, kind: e.kind, allDay: e.allDay || undefined })),
        breaks: v.plan.breaks,
        tasks: v.tasks.map((t) => taskBrief(rc.ctx, t)),
        overdue: v.overdue.map((t) => taskBrief(rc.ctx, t)),
        workload: {
          status: v.analysis.status,
          availableMin: v.analysis.availableMin,
          remainingDemandMin: v.analysis.remainingDemandMin,
          overloadMin: v.analysis.overloadMin,
        },
        conflicts: v.analysis.conflicts.map((c) => c.message),
        progress: v.progress,
      };
    },
  }),
  tool({
    name: "list_tasks",
    description:
      "Search tasks. scope: open (default), done, all, inbox (unprocessed ideas), backlog (open tasks with no planned day). Optional date range on planned day, project, or text query.",
    input: z.object({
      scope: z.enum(["open", "done", "all", "inbox", "backlog"]).default("open"),
      from: zDate.optional(),
      to: zDate.optional(),
      project: z.string().optional(),
      query: z.string().max(100).optional(),
      limit: z.number().int().min(1).max(100).default(40),
    }),
    write: false,
    run: (rc, i) => {
      const projectId = i.project ? resolveProject(rc.ctx, i.project) : undefined;
      const q = i.query?.toLowerCase();
      const tasks = rc.ctx.store
        .all("task")
        .filter((t) => !isTemplate(t))
        .filter((t) => {
          if (i.scope === "open") return isOpen(t) && t.status !== "inbox";
          if (i.scope === "done") return t.status === "done";
          if (i.scope === "inbox") return t.status === "inbox";
          if (i.scope === "backlog") return isOpen(t) && t.status !== "inbox" && !t.plannedDate;
          return true;
        })
        .filter((t) => (i.from ? (t.plannedDate ?? "") >= i.from : true))
        .filter((t) => (i.to ? (t.plannedDate ?? "9999") <= i.to : true))
        .filter((t) => (projectId ? t.projectId === projectId : true))
        .filter((t) => (q ? `${t.title} ${t.description} ${t.tags.join(" ")}`.toLowerCase().includes(q) : true));
      return { count: tasks.length, tasks: tasks.slice(0, i.limit).map((t) => taskBrief(rc.ctx, t)) };
    },
  }),
  tool({
    name: "get_task",
    description: "Read one task in full: description, notes, subtasks (with ids), dependencies, recurrence, links.",
    input: z.object({ id: z.string() }),
    write: false,
    run: (rc, i) => {
      const t = getTask(rc.ctx, i.id);
      return {
        ...taskBrief(rc.ctx, t),
        description: t.description,
        notes: t.notes,
        subtasks: t.subtasks,
        dependsOn: t.dependsOn.map((d) => ({ id: d, title: rc.ctx.store.get("task", d)?.title ?? "(deleted)" })),
        tags: t.tags,
        category: t.category,
        startDate: t.startDate,
        actualMin: t.actualMin,
        completedAt: t.completedAt,
        links: t.links,
      };
    },
  }),
  tool({
    name: "list_projects",
    description: "List projects with deadlines and open/done task counts.",
    input: z.object({}),
    write: false,
    run: (rc) => {
      const tasks = rc.ctx.store.all("task").filter((t) => !isTemplate(t));
      return rc.ctx.store.all("project").map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status,
        deadline: p.deadline,
        open: tasks.filter((t) => t.projectId === p.id && isOpen(t)).length,
        done: tasks.filter((t) => t.projectId === p.id && t.status === "done").length,
      }));
    },
  }),
  tool({
    name: "list_events",
    description: "List fixed calendar events (commitments, breaks, unavailable periods) between two dates, recurring ones expanded.",
    input: z.object({ from: zDate, to: zDate }),
    write: false,
    run: (rc, i) =>
      eventsBetween(rc.ctx, i.from, i.to).map((e) => ({
        id: e.id,
        date: e.occurrenceDate,
        title: e.title,
        start: e.start,
        end: e.end,
        kind: e.kind,
        recurring: e.recurrence ? true : undefined,
      })),
  }),
  tool({
    name: "upcoming_deadlines",
    description: "Open tasks and projects with a deadline within the next N days (default 7), soonest first, including overdue ones.",
    input: z.object({ days: z.number().int().min(1).max(90).default(7) }),
    write: false,
    run: (rc, i) => {
      const now = localNow(rc.ctx);
      const limit = `${addDays(now.date, i.days)}T23:59`;
      const tasks = rc.ctx.store
        .all("task")
        .filter((t) => !isTemplate(t) && isOpen(t) && t.dueAt && t.dueAt <= limit)
        .sort((a, b) => a.dueAt!.localeCompare(b.dueAt!));
      const projects = rc.ctx.store.all("project").filter((p) => p.status === "active" && p.deadline && p.deadline <= limit.slice(0, 10));
      return {
        tasks: tasks.map((t) => ({ ...taskBrief(rc.ctx, t), overdue: t.dueAt! < now.dateTime || undefined })),
        projects: projects.map((p) => ({ id: p.id, name: p.name, deadline: p.deadline })),
      };
    },
  }),
  tool({
    name: "find_free_time",
    description: "Find free blocks of at least minMinutes between two dates, inside planning hours, avoiding events and scheduled tasks.",
    input: z.object({ from: zDate, to: zDate, minMinutes: z.number().int().min(5).max(600) }),
    write: false,
    run: (rc, i) => {
      if (i.to < i.from) throw new DomainError("validation", "`to` must be on or after `from`.");
      if (i.to > addDays(i.from, 31)) throw new DomainError("validation", "Search at most 31 days at once.");
      return findFreeTime(rc.ctx, i.from, i.to, i.minMinutes).slice(0, 40);
    },
  }),
  tool({
    name: "check_conflicts",
    description: "Check a day's current schedule for overlaps, missed deadlines, dependency order problems, and overload.",
    input: z.object({ date: zDate }),
    write: false,
    run: (rc, i) => {
      const a = analyze(rc.ctx, i.date);
      return { status: a.status, availableMin: a.availableMin, remainingDemandMin: a.remainingDemandMin, overloadMin: a.overloadMin, conflicts: a.conflicts };
    },
  }),
  tool({
    name: "get_progress",
    description: "Progress for a day: completed vs remaining, estimated vs actual minutes, completion streak.",
    input: z.object({ date: zDate.optional() }),
    write: false,
    run: (rc, i) => {
      const date = i.date ?? localNow(rc.ctx).date;
      const v = dayView(rc.ctx, date);
      return {
        date,
        ...v.progress,
        streakDays: completionStreak(rc.ctx),
        completed: v.tasks.filter((t) => t.status === "done").map((t) => ({ id: t.id, title: t.title, estimateMin: t.estimateMin, actualMin: t.actualMin })),
        remaining: v.tasks.filter((t) => isOpen(t)).map((t) => taskBrief(rc.ctx, t)),
      };
    },
  }),
  tool({
    name: "review_period",
    description:
      "Look back (or ahead) over a date range, up to 31 days: for each day, tasks completed (with estimated vs actual minutes), tasks planned but not done, fixed events, and the evening review note and reasons. Use it to answer what was done, what slipped, and what still needs doing.",
    input: z.object({ from: zDate, to: zDate }),
    write: false,
    run: (rc, i) => {
      if (i.to < i.from) throw new DomainError("validation", "`to` must be on or after `from`.");
      if (i.to > addDays(i.from, 30)) throw new DomainError("validation", "Review at most 31 days at once.");
      const tz = rc.ctx.settings.timeZone;
      const tasks = rc.ctx.store.all("task").filter((t) => !isTemplate(t));
      const events = eventsBetween(rc.ctx, i.from, i.to);
      const days: unknown[] = [];
      for (let d = i.from; d <= i.to; d = addDays(d, 1)) {
        const completed = tasks.filter((t) => t.status === "done" && t.completedAt && zonedNow(tz, new Date(t.completedAt)).date === d);
        const notDone = tasks.filter((t) => isOpen(t) && t.plannedDate === d);
        const dayEvents = events.filter((e) => e.occurrenceDate === d);
        const review = rc.ctx.store.get("dayPlan", d)?.review ?? null;
        if (!completed.length && !notDone.length && !dayEvents.length && !review) continue;
        days.push({
          date: d,
          completed: completed.map((t) => ({ id: t.id, title: t.title, estimateMin: t.estimateMin, actualMin: t.actualMin, project: projectName(rc.ctx, t.projectId) })),
          notDone: notDone.map((t) => ({ ...taskBrief(rc.ctx, t), reason: review?.reasons[t.id] || undefined })),
          events: dayEvents.map((e) => ({ title: e.title, start: e.start, end: e.end, kind: e.kind })),
          review: review ? { note: review.note || undefined, reasons: Object.keys(review.reasons).length ? review.reasons : undefined } : undefined,
        });
      }
      return { from: i.from, to: i.to, days };
    },
  }),
  tool({
    name: "suggest_next",
    description: "Rank what to work on right now: in-progress task, task scheduled now, then the highest-scoring open task for today that fits before the next commitment. Includes score breakdown.",
    input: z.object({}),
    write: false,
    run: (rc) => {
      const now = localNow(rc.ctx);
      const v = dayView(rc.ctx, now.date);
      const open = [...v.tasks, ...v.overdue].filter((t) => isOpen(t) && t.status !== "inbox");
      const nextEvent = v.events.find((e) => !e.allDay && e.start > now.time);
      const ranked = open
        .map((t) => ({
          t,
          score: v.scores[t.id]?.total ?? 0,
          now: t.status === "in_progress" || (t.scheduledStart && t.scheduledStart <= now.dateTime && (t.scheduledEnd ?? "") > now.dateTime),
        }))
        .sort((a, b) => Number(b.now) - Number(a.now) || b.score - a.score);
      return {
        now: now.dateTime,
        nextCommitment: nextEvent ? { title: nextEvent.title, start: nextEvent.start } : null,
        ranked: ranked.slice(0, 5).map((r) => ({ ...taskBrief(rc.ctx, r.t), score: r.score, happeningNow: r.now || undefined, scoreParts: v.scores[r.t.id]?.parts })),
      };
    },
  }),
  tool({
    name: "get_preferences",
    description: "Read the user's planning preferences (hours, breaks, peak energy, strategy) and their saved memory notes.",
    input: z.object({}),
    write: false,
    run: (rc) => {
      const s = rc.ctx.settings;
      return {
        name: s.displayName,
        timeZone: s.timeZone,
        workDays: s.workDays,
        dayStart: s.dayStart,
        dayEnd: s.dayEnd,
        weekend: s.weekendPlanning ? `${s.weekendStart}–${s.weekendEnd}` : "no planning",
        sleep: `${s.sleepStart}–${s.sleepEnd}`,
        defaultEstimateMin: s.defaultEstimateMin,
        focusBlockMin: s.focusBlockMin,
        breakMin: s.breakMin,
        bufferMin: s.bufferMin,
        lunch: s.lunch,
        peakEnergy: s.peakEnergy,
        strategy: s.strategy,
        memory: rc.ctx.store.all("memory").map((m) => ({ id: m.id, text: m.text })),
      };
    },
  }),

  // ---- write (staged) ---------------------------------------------------
  tool({
    name: "create_task",
    description:
      "Create a task. Use plannedDate to put it on a day (flexible); add start (HH:mm) only when the user asked for a precise time — that pins it. due accepts a date or date-time; dueHard=false for soft targets. energy 'high' marks demanding work. dependsOn takes task ids that must be done first. Returns the new id.",
    input: z.object({
      title: z.string().min(1).max(200),
      description: z.string().max(2000).optional(),
      priority: zPriority.optional(),
      estimateMin: zMinutes.optional(),
      plannedDate: zDate.optional(),
      start: zTime.optional(),
      pin: z.boolean().optional(),
      due: zDue.optional(),
      dueHard: z.boolean().optional(),
      energy: zEnergy.optional(),
      project: z.string().optional(),
      category: z.string().max(60).optional(),
      tags: z.array(z.string().max(40)).max(10).optional(),
      subtasks: z.array(z.string().min(1).max(200)).max(20).optional(),
      dependsOn: z.array(z.string()).max(10).optional(),
      recurrence: zRecurrence.optional(),
      inbox: z.boolean().optional(),
      notes: z.string().max(4000).optional(),
    }),
    write: true,
    run: (rc, i) => {
      if (i.start && !i.plannedDate) throw new DomainError("validation", "Give plannedDate together with start.");
      const projectId = resolveProject(rc.ctx, i.project);
      const t = createTask(rc.ctx, {
        title: i.title,
        description: i.description,
        priority: i.priority,
        estimateMin: i.estimateMin,
        plannedDate: i.plannedDate ?? null,
        scheduledStart: i.start && i.plannedDate ? combine(i.plannedDate, i.start) : null,
        pinned: i.start ? (i.pin ?? true) : false,
        dueAt: i.due ?? null,
        dueHard: i.dueHard,
        energy: i.energy,
        projectId: projectId ?? null,
        category: i.category ?? null,
        tags: i.tags,
        subtasks: i.subtasks,
        dependsOn: i.dependsOn,
        recurrence: i.recurrence ?? null,
        notes: i.notes,
        status: i.inbox ? "inbox" : undefined,
        source: "ai",
      });
      return { created: taskBrief(rc.ctx, t) };
    },
  }),
  tool({
    name: "update_task",
    description:
      "Change fields of a task: title, description, priority, estimateMin, due (null clears), dueHard, energy, project (null clears), category, tags, notes, startDate, status (todo, in_progress, inbox, cancelled). Use complete_task / schedule_task / move_task for those actions.",
    input: z.object({
      id: z.string(),
      title: z.string().min(1).max(200).optional(),
      description: z.string().max(2000).optional(),
      priority: zPriority.optional(),
      estimateMin: zMinutes.optional(),
      due: zDue.nullable().optional(),
      dueHard: z.boolean().optional(),
      energy: zEnergy.optional(),
      project: z.string().nullable().optional(),
      category: z.string().max(60).nullable().optional(),
      tags: z.array(z.string().max(40)).max(10).optional(),
      notes: z.string().max(4000).optional(),
      startDate: zDate.nullable().optional(),
      status: z.enum(["todo", "in_progress", "inbox", "cancelled"]).optional(),
    }),
    write: true,
    run: (rc, i) => {
      const { id, due, project, ...rest } = i;
      const projectId = resolveProject(rc.ctx, project);
      const t = updateTask(rc.ctx, id, {
        ...rest,
        ...(due !== undefined ? { dueAt: due } : {}),
        ...(projectId !== undefined ? { projectId } : {}),
      });
      return { updated: taskBrief(rc.ctx, t) };
    },
  }),
  tool({
    name: "complete_task",
    description: "Mark a task as done (optionally with the actual minutes spent).",
    input: z.object({ id: z.string(), actualMin: z.number().int().min(0).max(1440).optional() }),
    write: true,
    run: (rc, i) => ({ completed: taskBrief(rc.ctx, completeTask(rc.ctx, i.id, { actualMin: i.actualMin ?? null })) }),
  }),
  tool({
    name: "reopen_task",
    description: "Mark a completed or cancelled task as not done again.",
    input: z.object({ id: z.string() }),
    write: true,
    run: (rc, i) => ({ reopened: taskBrief(rc.ctx, reopenTask(rc.ctx, i.id)) }),
  }),
  tool({
    name: "delete_task",
    description: "Delete a task permanently. Always requires the user's approval in the app; prefer cancelling (update_task status=cancelled) when unsure.",
    input: z.object({ id: z.string() }),
    write: true,
    run: (rc, i) => {
      const t = getTask(rc.ctx, i.id);
      deleteTask(rc.ctx, i.id);
      return { deleted: { id: t.id, title: t.title } };
    },
  }),
  tool({
    name: "schedule_task",
    description:
      "Put a task at a precise time on a day (start HH:mm; end = start + estimate). pin=true (default) keeps it fixed when the day is re-planned. Returns conflicts on that day.",
    input: z.object({ id: z.string(), date: zDate, start: zTime, pin: z.boolean().default(true) }),
    write: true,
    run: (rc, i) => {
      const t = scheduleTask(rc.ctx, i.id, i.date, i.start, { pin: i.pin });
      const a = analyze(rc.ctx, i.date);
      return { scheduled: taskBrief(rc.ctx, t), conflicts: a.conflicts.filter((c) => c.taskId === t.id || c.otherId === t.id).map((c) => c.message) };
    },
  }),
  tool({
    name: "move_task",
    description: "Move a task to another day. Its deadline is never changed. keepTime=true keeps the same clock time; otherwise it becomes flexible on that day.",
    input: z.object({ id: z.string(), date: zDate, keepTime: z.boolean().default(false) }),
    write: true,
    run: (rc, i) => ({ moved: taskBrief(rc.ctx, moveTask(rc.ctx, i.id, i.date, { keepTime: i.keepTime })) }),
  }),
  tool({
    name: "unschedule_task",
    description: "Remove a task's time slot (it stays flexible on its day), or with toBacklog=true remove it from its day entirely.",
    input: z.object({ id: z.string(), toBacklog: z.boolean().default(false) }),
    write: true,
    run: (rc, i) => ({ unscheduled: taskBrief(rc.ctx, unscheduleTask(rc.ctx, i.id, { toBacklog: i.toBacklog })) }),
  }),
  tool({
    name: "postpone_tasks",
    description:
      "Move several open tasks to another day without touching their deadlines. Give ids, or unfinishedOn=<date> to move every open task planned for that day.",
    input: z
      .object({ ids: z.array(z.string()).max(100).optional(), unfinishedOn: zDate.optional(), toDate: zDate })
      .refine((v) => (v.ids && v.ids.length > 0) || v.unfinishedOn, { message: "Give ids or unfinishedOn" }),
    write: true,
    run: (rc, i) => {
      const ids =
        i.ids && i.ids.length > 0
          ? i.ids.map((id) => getTask(rc.ctx, id).id)
          : rc.ctx.store
              .all("task")
              .filter((t) => !isTemplate(t) && isOpen(t) && t.plannedDate === i.unfinishedOn)
              .map((t) => t.id);
      const moved = postponeTasks(rc.ctx, ids, i.toDate);
      return { moved: moved.map((t) => ({ id: t.id, title: t.title, dueAt: t.dueAt })), toDate: i.toDate };
    },
  }),
  tool({
    name: "set_dependency",
    description: "Make a task wait for another one (taskId depends on dependsOnId), or remove that link with remove=true. Cycles are rejected.",
    input: z.object({ taskId: z.string(), dependsOnId: z.string(), remove: z.boolean().default(false) }),
    write: true,
    run: (rc, i) => ({ updated: taskBrief(rc.ctx, setDependency(rc.ctx, i.taskId, i.dependsOnId, i.remove)) }),
  }),
  tool({
    name: "edit_subtasks",
    description: "Add subtasks (titles), mark subtasks done, or remove them (subtask ids from get_task).",
    input: z.object({
      taskId: z.string(),
      add: z.array(z.string().min(1).max(200)).max(20).optional(),
      complete: z.array(z.string()).max(50).optional(),
      remove: z.array(z.string()).max(50).optional(),
    }),
    write: true,
    run: (rc, i) => {
      const t = editSubtasks(rc.ctx, i.taskId, { add: i.add, complete: i.complete, remove: i.remove });
      return { subtasks: t.subtasks };
    },
  }),
  tool({
    name: "create_project",
    description: "Create a project (optional deadline as YYYY-MM-DD).",
    input: z.object({ name: z.string().min(1).max(80), description: z.string().max(2000).optional(), deadline: zDate.optional() }),
    write: true,
    run: (rc, i) => {
      const p = createProject(rc.ctx, { name: i.name, description: i.description, deadline: i.deadline ?? null });
      return { created: { id: p.id, name: p.name, deadline: p.deadline } };
    },
  }),
  tool({
    name: "update_project",
    description: "Rename a project, change its description or deadline (null clears), or archive it.",
    input: z.object({
      id: z.string(),
      name: z.string().min(1).max(80).optional(),
      description: z.string().max(2000).optional(),
      deadline: zDate.nullable().optional(),
      status: z.enum(["active", "archived"]).optional(),
    }),
    write: true,
    run: (rc, i) => {
      const { id, ...patch } = i;
      const p = updateProject(rc.ctx, id, patch);
      return { updated: { id: p.id, name: p.name, deadline: p.deadline, status: p.status } };
    },
  }),
  tool({
    name: "create_event",
    description:
      "Create a fixed calendar block the scheduler must respect: kind 'commitment' (class, meeting, appointment), 'break' (lunch, rest the user asked for) or 'unavailable'. Optional weekly/daily recurrence.",
    input: z.object({
      title: z.string().min(1).max(200),
      date: zDate,
      start: zTime,
      end: zTime,
      kind: zEventKind.default("commitment"),
      location: z.string().max(200).optional(),
      recurrence: zRecurrence.optional(),
    }),
    write: true,
    run: (rc, i) => {
      const e = createEvent(rc.ctx, { ...i, recurrence: i.recurrence ?? null, source: "ai" });
      return { created: { id: e.id, title: e.title, date: e.date, start: e.start, end: e.end, kind: e.kind } };
    },
  }),
  tool({
    name: "update_event",
    description: "Change an event's title, date, start, end, kind or location.",
    input: z.object({
      id: z.string(),
      title: z.string().min(1).max(200).optional(),
      date: zDate.optional(),
      start: zTime.optional(),
      end: zTime.optional(),
      kind: zEventKind.optional(),
      location: z.string().max(200).optional(),
    }),
    write: true,
    run: (rc, i) => {
      const { id, ...patch } = i;
      const e = updateEvent(rc.ctx, id, patch);
      return { updated: { id: e.id, title: e.title, date: e.date, start: e.start, end: e.end, kind: e.kind } };
    },
  }),
  tool({
    name: "delete_event",
    description: "Delete an event, or only one occurrence of a recurring event (occurrenceDate). Requires the user's approval.",
    input: z.object({ id: z.string(), occurrenceDate: zDate.optional() }),
    write: true,
    run: (rc, i) => {
      deleteEvent(rc.ctx, i.id, i.occurrenceDate ? { occurrenceDate: i.occurrenceDate } : {});
      return { deleted: i.id };
    },
  }),
  tool({
    name: "set_day_constraints",
    description:
      "Set day-specific limits: dayStart/dayEnd (HH:mm, null = back to defaults), e.g. 'finish by 22:30'; intensity 'light' for a lighter day, 'normal' otherwise.",
    input: z.object({ date: zDate, dayStart: zTime.nullable().optional(), dayEnd: zTime.nullable().optional(), intensity: zIntensity.optional() }),
    write: true,
    run: (rc, i) => {
      const p = patchDayPlan(rc.ctx, i.date, { dayStart: i.dayStart, dayEnd: i.dayEnd, intensity: i.intensity });
      return { date: p.date, dayStart: p.dayStart, dayEnd: p.dayEnd, intensity: p.intensity };
    },
  }),
  tool({
    name: "plan_day",
    description:
      "Run the deterministic scheduler on a day and stage the resulting times. mode 'full' builds the day by priority score; 'preserve' keeps still-valid times and fills gaps (use after a small change); 'reflow' shifts the rest of the day forward from now after a delay. Completed and pinned tasks never move; events are never overlapped. Returns the schedule, what does not fit (with a suggested day) and an explanation. Planning always starts from the current time, so time already lost is accounted for automatically. blockFromNowMin is only for future unavailability starting now (e.g. 'I must leave for an hour'), never for time already lost.",
    input: z.object({
      date: zDate,
      mode: zPlanMode.default("full"),
      intensity: zIntensity.optional(),
      blockFromNowMin: z.number().int().min(0).max(600).optional(),
    }),
    write: true,
    run: (rc, i) => {
      const result = computePlan(rc.ctx, i.date, { mode: i.mode, intensity: i.intensity, blockFromNowMin: i.blockFromNowMin });
      applyPlan(rc.ctx, result, { intensity: i.intensity });
      rc.plans = [...rc.plans.filter((p) => p.date !== result.date), result];
      return planSummary(rc.ctx, result);
    },
  }),
  tool({
    name: "plan_range",
    description:
      "Spread unplanned tasks (or the given taskIds) over several days, earliest deadline first, within each day's free time, then plan each affected day. Use for 'plan my week'.",
    input: z.object({ from: zDate, to: zDate, taskIds: z.array(z.string()).max(100).optional() }),
    write: true,
    run: (rc, i) => {
      if (i.to < i.from) throw new DomainError("validation", "`to` must be on or after `from`.");
      if (i.to > addDays(i.from, 21)) throw new DomainError("validation", "Plan at most 3 weeks at once.");
      const r = distributeTasks(rc.ctx, i.from, i.to, i.taskIds);
      for (const p of r.plans) rc.plans = [...rc.plans.filter((x) => x.date !== p.date), p];
      return {
        assigned: r.assigned.map((a) => ({ ...a, title: rc.ctx.store.get("task", a.taskId)?.title })),
        unassigned: r.unassigned.map((u) => ({ ...u, title: rc.ctx.store.get("task", u.taskId)?.title })),
        days: r.plans.map((p) => planSummary(rc.ctx, p)),
      };
    },
  }),
  tool({
    name: "remember",
    description: "Save a short, lasting preference or fact about how the user likes to work (visible and deletable in Settings). Only for explicit, durable preferences.",
    input: z.object({ text: z.string().min(3).max(300) }),
    write: true,
    run: (rc, i) => ({ saved: addMemory(rc.ctx, i.text, "ai") }),
  }),
  tool({
    name: "forget",
    description: "Delete a saved memory note by id.",
    input: z.object({ id: z.string() }),
    write: true,
    run: (rc, i) => {
      removeMemory(rc.ctx, i.id);
      return { forgotten: i.id };
    },
  }),
] as const satisfies readonly ToolDef[];

const TOOL_MAP = new Map<string, ToolDef>(TOOLS.map((t) => [t.name, t as unknown as ToolDef]));

export function toolDefinitions(readOnly = false) {
  return TOOLS.filter((t) => !readOnly || !t.write).map((t) => {
    const schema = z.toJSONSchema(t.input, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    delete schema.$schema;
    return { name: t.name, description: t.description, inputSchema: schema };
  });
}

export type ToolResult = { ok: true; result: unknown } | { ok: false; error: string };

function formatIssues(issues: z.core.$ZodIssue[]): string {
  return issues
    .slice(0, 8)
    .map((i) => `${i.path.length ? i.path.join(".") : "input"}: ${i.message}`)
    .join("; ");
}

/**
 * Validate and execute one tool call against the run's overlay. Invalid input,
 * unknown tools and domain errors are returned as errors and leave the staged
 * state exactly as it was before the call.
 */
export function executeTool(rc: RunContext, name: string, rawInput: unknown): ToolResult {
  const record = (r: ToolResult): ToolResult => {
    const entry: ToolCallRecord = r.ok ? { name, ok: true } : { name, ok: false, error: r.error };
    rc.toolCalls.push(entry);
    rc.onTool?.(entry);
    return r;
  };
  if (rc.closed) return record({ ok: false, error: "This request has finished; no further changes are accepted." });
  if (rc.toolCalls.length >= rc.maxToolCalls) {
    return record({ ok: false, error: `Tool budget of ${rc.maxToolCalls} calls reached. Stop and answer with what you have.` });
  }
  const def = TOOL_MAP.get(name);
  if (!def) return record({ ok: false, error: `Unknown tool "${name}".` });
  if (def.write && rc.readOnly) return record({ ok: false, error: "This request is read-only; changes are not allowed." });
  const input = rawInput === undefined || rawInput === null ? {} : rawInput;
  if (typeof input !== "object" || Array.isArray(input)) {
    return record({ ok: false, error: "Invalid input: expected a JSON object." });
  }
  const parsed = def.input.safeParse(input);
  if (!parsed.success) return record({ ok: false, error: `Invalid input: ${formatIssues(parsed.error.issues)}` });
  const snapshot = rc.overlay.snapshot();
  try {
    const result = def.run(rc, parsed.data);
    return record({ ok: true, result: result ?? { ok: true } });
  } catch (err) {
    rc.overlay.restore(snapshot);
    if (err instanceof DomainError) return record({ ok: false, error: err.message });
    return record({ ok: false, error: "Internal error while running this tool; nothing was changed." });
  }
}

export function isWriteTool(name: string): boolean {
  return TOOL_MAP.get(name)?.write ?? false;
}

export const TOOL_NAMES = TOOLS.map((t) => t.name);
