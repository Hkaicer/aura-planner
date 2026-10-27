import type { DayPlan, EventOccurrence, Intensity, PlanMode, Settings, Task } from "../../shared/schemas";
import { addDays, combineMinutes, dateOf, dateRange, fromMinutes, isoWeekday, minutesOf, toMinutes } from "../../shared/time";
import {
  analyzeDay,
  freeBlocks,
  planDay,
  scoreTask,
  type DayAnalysis,
  type DependencyInfo,
  type EngineBlock,
  type EngineConfig,
  type EngineTask,
  type PlanResult,
  type TaskScore,
} from "../scheduling/engine";
import { localNow, nowIso, touch, type DomainContext } from "./context";
import { eventsBetween, getDayPlan, patchDayPlan } from "./entities";
import { isOpen, isTemplate, materializeRecurring, overdueTasks, tasksForDate } from "./tasks";

export interface DayWindow {
  start: number;
  end: number;
  isWorkDay: boolean;
  source: "work" | "weekend" | "override" | "off";
}

export function dayWindow(settings: Settings, plan: DayPlan | null, date: string): DayWindow {
  const weekday = isoWeekday(date);
  const isWorkDay = settings.workDays.includes(weekday);
  let start: number;
  let end: number;
  let source: DayWindow["source"];
  if (isWorkDay) {
    start = toMinutes(settings.dayStart);
    end = toMinutes(settings.dayEnd);
    source = "work";
  } else if (settings.weekendPlanning) {
    start = toMinutes(settings.weekendStart);
    end = toMinutes(settings.weekendEnd);
    source = "weekend";
  } else {
    start = toMinutes(settings.dayStart);
    end = start;
    source = "off";
  }
  // Never plan into the sleep window.
  const wake = toMinutes(settings.sleepEnd);
  const bed = toMinutes(settings.sleepStart);
  if (bed > wake) {
    start = Math.max(start, wake);
    end = Math.min(end, bed);
  }
  if (plan?.dayStart) {
    start = toMinutes(plan.dayStart);
    source = "override";
  }
  if (plan?.dayEnd) {
    end = toMinutes(plan.dayEnd);
    source = "override";
  }
  if (source === "override" && end <= start) end = start;
  return { start, end: Math.max(start, end), isWorkDay, source };
}

export function engineConfig(settings: Settings, window: { start: number; end: number }, intensity: Intensity): EngineConfig {
  const noon = 12 * 60;
  const peak =
    settings.peakEnergy === "morning"
      ? { start: window.start, end: Math.max(window.start, noon) }
      : settings.peakEnergy === "afternoon"
        ? { start: 13 * 60, end: 17 * 60 + 30 }
        : { start: 17 * 60 + 30, end: window.end };
  return {
    bufferMin: settings.bufferMin,
    focusBlockMin: settings.focusBlockMin,
    breakMin: settings.breakMin,
    lunch: {
      enabled: settings.lunch.enabled,
      earliest: toMinutes(settings.lunch.earliest),
      latest: toMinutes(settings.lunch.latest),
      durationMin: settings.lunch.durationMin,
    },
    peak,
    strategy: settings.strategy,
    intensity,
  };
}

export function toEngineTask(t: Task, projectDeadline: string | null): EngineTask {
  return {
    id: t.id,
    title: t.title,
    estimateMin: t.estimateMin,
    priority: t.priority,
    energy: t.energy,
    status: t.status,
    dueAt: t.dueAt,
    dueHard: t.dueHard,
    dependsOn: t.dependsOn,
    pinned: t.pinned,
    scheduledStart: t.scheduledStart,
    scheduledEnd: t.scheduledEnd,
    plannedDate: t.plannedDate,
    postponedCount: t.postponedCount,
    projectDeadline,
    createdAt: t.createdAt,
  };
}

function blocksFor(settings: Settings, events: EventOccurrence[], date: string): EngineBlock[] {
  const blocks: EngineBlock[] = events
    .filter((e) => e.occurrenceDate === date && !e.allDay)
    .map((e) => ({ id: e.id, title: e.title, start: toMinutes(e.start), end: toMinutes(e.end), kind: e.kind }));
  const weekday = isoWeekday(date);
  for (const u of settings.unavailable) {
    if (!u.weekdays.includes(weekday)) continue;
    blocks.push({ id: u.id, title: u.label || "Unavailable", start: toMinutes(u.start), end: toMinutes(u.end), kind: "unavailable" });
  }
  return blocks;
}

interface DayContext {
  date: string;
  plan: DayPlan;
  window: DayWindow;
  events: EventOccurrence[];
  blocks: EngineBlock[];
  tasks: Task[];
  engineTasks: EngineTask[];
  dependencies: Record<string, DependencyInfo>;
  now: { date: string; minutes: number };
  config: EngineConfig;
}

function loadDay(ctx: DomainContext, date: string, intensity?: Intensity): DayContext {
  const plan = getDayPlan(ctx, date);
  const window = dayWindow(ctx.settings, plan, date);
  const events = eventsBetween(ctx, date, date);
  const tasks = tasksForDate(ctx, date);
  const projects = new Map(ctx.store.all("project").map((p) => [p.id, p]));
  const allTasks = new Map(ctx.store.all("task").map((t) => [t.id, t]));
  const dependencies: Record<string, DependencyInfo> = {};
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      const dep = allTasks.get(d);
      if (dep) dependencies[d] = { status: dep.status, plannedDate: dep.plannedDate, scheduledEnd: dep.scheduledEnd, title: dep.title };
    }
  }
  const now = localNow(ctx);
  return {
    date,
    plan,
    window,
    events,
    blocks: blocksFor(ctx.settings, events, date),
    tasks,
    engineTasks: tasks.map((t) => toEngineTask(t, t.projectId ? (projects.get(t.projectId)?.deadline ?? null) : null)),
    dependencies,
    now: { date: now.date, minutes: now.minutes },
    config: engineConfig(ctx.settings, window, intensity ?? plan.intensity),
  };
}

export function computePlan(
  ctx: DomainContext,
  date: string,
  opts: { mode: PlanMode; intensity?: Intensity; blockFromNowMin?: number; taskIds?: string[] },
): PlanResult {
  const day = loadDay(ctx, date, opts.intensity);
  const tasks = opts.taskIds ? day.engineTasks.filter((t) => opts.taskIds!.includes(t.id) || t.pinned) : day.engineTasks;
  return planDay({
    date,
    now: day.now,
    window: { start: day.window.start, end: day.window.end },
    blocks: day.blocks,
    tasks,
    dependencies: day.dependencies,
    config: day.config,
    mode: opts.mode,
    ...(opts.blockFromNowMin ? { blockFromNowMin: opts.blockFromNowMin } : {}),
  });
}

/**
 * Write a plan into the tasks of a day. Completed and pinned tasks are never
 * touched; tasks that did not fit lose their time slot but stay on the day so
 * nothing disappears silently.
 */
export function applyPlan(ctx: DomainContext, result: PlanResult, opts: { intensity?: Intensity; accept?: boolean } = {}) {
  const placed = new Map(result.placements.map((p) => [p.taskId, p]));
  const overflowIds = new Set(result.overflow.map((o) => o.taskId));
  for (const t of tasksForDate(ctx, result.date)) {
    if (!isOpen(t) || t.pinned) continue;
    const p = placed.get(t.id);
    if (p) {
      const start = combineMinutes(result.date, p.start);
      const end = combineMinutes(result.date, p.end);
      if (t.scheduledStart !== start || t.scheduledEnd !== end || t.plannedDate !== result.date) {
        ctx.store.put("task", touch(ctx, { ...t, plannedDate: result.date, scheduledStart: start, scheduledEnd: end }));
      }
    } else if (overflowIds.has(t.id) && t.scheduledStart) {
      ctx.store.put("task", touch(ctx, { ...t, scheduledStart: null, scheduledEnd: null }));
    }
  }
  const breaks = [
    ...(result.lunch ? [{ start: fromMinutes(result.lunch.start), end: fromMinutes(result.lunch.end), label: "Lunch" }] : []),
    ...result.breaks.map((b) => ({ start: fromMinutes(b.start), end: fromMinutes(b.end), label: "Break" })),
  ].sort((a, b) => a.start.localeCompare(b.start));
  patchDayPlan(ctx, result.date, {
    breaks,
    ...(opts.intensity ? { intensity: opts.intensity } : {}),
    ...(opts.accept ? { acceptedAt: nowIso(ctx) } : {}),
  });
}

/** Move tasks to another day, keeping deadlines untouched. */
export function postponeTasks(ctx: DomainContext, ids: string[], toDate: string): Task[] {
  const out: Task[] = [];
  for (const id of ids) {
    const t = ctx.store.get("task", id);
    if (!t || !isOpen(t)) continue;
    const next = touch(ctx, {
      ...t,
      plannedDate: toDate,
      scheduledStart: null,
      scheduledEnd: null,
      pinned: false,
      postponedCount: t.plannedDate && toDate > t.plannedDate ? t.postponedCount + 1 : t.postponedCount,
    });
    ctx.store.put("task", next);
    out.push(next);
  }
  return out;
}

export function analyze(ctx: DomainContext, date: string): DayAnalysis & { window: DayWindow } {
  const day = loadDay(ctx, date);
  const result = analyzeDay({
    date,
    now: day.now,
    window: day.window,
    blocks: day.blocks,
    tasks: day.engineTasks,
    dependencies: day.dependencies,
    config: day.config,
  });
  return { ...result, window: day.window };
}

export function scoresFor(ctx: DomainContext, tasks: Task[]): Record<string, TaskScore> {
  const now = localNow(ctx);
  const projects = new Map(ctx.store.all("project").map((p) => [p.id, p]));
  const out: Record<string, TaskScore> = {};
  for (const t of tasks) {
    out[t.id] = scoreTask(toEngineTask(t, t.projectId ? (projects.get(t.projectId)?.deadline ?? null) : null), now.dateTime, ctx.settings.strategy);
  }
  return out;
}

export interface FreeBlock {
  date: string;
  start: string;
  end: string;
  minutes: number;
}

export function findFreeTime(ctx: DomainContext, from: string, to: string, minMinutes: number): FreeBlock[] {
  const now = localNow(ctx);
  const out: FreeBlock[] = [];
  for (const date of dateRange(from < now.date ? now.date : from, to)) {
    const day = loadDay(ctx, date);
    const busy = [
      ...day.blocks.map((b) => ({ start: b.start, end: b.end })),
      ...day.tasks
        .filter((t) => isOpen(t) && t.scheduledStart && dateOf(t.scheduledStart) === date)
        .map((t) => ({ start: minutesOf(t.scheduledStart!), end: t.scheduledEnd ? minutesOf(t.scheduledEnd) : minutesOf(t.scheduledStart!) + t.estimateMin })),
    ];
    const fromMin = date === now.date ? Math.ceil(now.minutes / 5) * 5 : day.window.start;
    for (const b of freeBlocks(day.window, busy, fromMin, minMinutes)) {
      out.push({ date, start: fromMinutes(b.start), end: fromMinutes(b.end), minutes: b.end - b.start });
    }
  }
  return out;
}

export interface DayLoad {
  date: string;
  availableMin: number;
  demandMin: number;
  status: DayAnalysis["status"];
}

export function dayLoads(ctx: DomainContext, from: string, to: string): DayLoad[] {
  return dateRange(from, to).map((date) => {
    const a = analyze(ctx, date);
    return { date, availableMin: a.availableMin, demandMin: a.remainingDemandMin, status: a.status };
  });
}

/** First day from `from` (up to 14 days) with enough spare capacity for a task. */
export function suggestDay(ctx: DomainContext, task: Task, from: string): string | null {
  const limit = task.dueAt ? dateOf(task.dueAt) : addDays(from, 14);
  for (const load of dayLoads(ctx, from, limit < from ? from : limit)) {
    if (load.availableMin - load.demandMin >= task.estimateMin) return load.date;
  }
  return null;
}

/**
 * Spread unplanned tasks over a range of days: earliest deadline first, never
 * after a hard deadline, never before a task's start date, within each day's
 * spare capacity. Returns the assignments; each day is then planned in
 * "preserve" mode so existing schedules move as little as possible.
 */
export function distributeTasks(
  ctx: DomainContext,
  from: string,
  to: string,
  taskIds?: string[],
): { assigned: { taskId: string; date: string }[]; unassigned: { taskId: string; reason: string }[]; plans: PlanResult[] } {
  const now = localNow(ctx);
  const start = from < now.date ? now.date : from;
  materializeRecurring(ctx, start, to);
  const candidates = ctx.store
    .all("task")
    .filter((t) => !isTemplate(t) && isOpen(t) && t.status !== "inbox")
    .filter((t) => (taskIds ? taskIds.includes(t.id) : t.plannedDate === null || t.plannedDate < start));
  const scores = scoresFor(ctx, candidates);
  candidates.sort(
    (a, b) => (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999") || (scores[b.id]?.total ?? 0) - (scores[a.id]?.total ?? 0),
  );
  const spare = new Map(dayLoads(ctx, start, to).map((l) => [l.date, Math.max(0, l.availableMin - l.demandMin)]));
  const assigned: { taskId: string; date: string }[] = [];
  const unassigned: { taskId: string; reason: string }[] = [];
  for (const t of candidates) {
    const earliest = t.startDate && t.startDate > start ? t.startDate : start;
    const latest = t.dueAt ? (dateOf(t.dueAt) < to ? dateOf(t.dueAt) : to) : to;
    let chosen: string | null = null;
    for (const date of dateRange(earliest, latest)) {
      if ((spare.get(date) ?? 0) >= t.estimateMin) {
        chosen = date;
        break;
      }
    }
    if (!chosen) {
      unassigned.push({ taskId: t.id, reason: t.dueAt && dateOf(t.dueAt) < earliest ? "deadline already passed" : "no day has enough free time" });
      continue;
    }
    spare.set(chosen, (spare.get(chosen) ?? 0) - t.estimateMin);
    ctx.store.put("task", touch(ctx, { ...t, plannedDate: chosen, scheduledStart: null, scheduledEnd: null, pinned: false }));
    assigned.push({ taskId: t.id, date: chosen });
  }
  const days = [...new Set(assigned.map((a) => a.date))].sort();
  const plans = days.map((date) => {
    const result = computePlan(ctx, date, { mode: "preserve" });
    applyPlan(ctx, result);
    return result;
  });
  return { assigned, unassigned, plans };
}

export interface DayView {
  date: string;
  today: string;
  now: string;
  window: { start: string; end: string; isWorkDay: boolean; source: DayWindow["source"] };
  plan: DayPlan;
  events: EventOccurrence[];
  tasks: Task[];
  overdue: Task[];
  analysis: DayAnalysis;
  progress: { total: number; done: number; pct: number; plannedMin: number; doneMin: number; actualMin: number };
  scores: Record<string, TaskScore>;
  streak: number;
}

export function completionStreak(ctx: DomainContext): number {
  const tz = ctx.settings.timeZone;
  const days = new Set(
    ctx.store
      .all("task")
      .filter((t) => t.status === "done" && t.completedAt)
      .map((t) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t.completedAt!))),
  );
  const todayDate = localNow(ctx).date;
  let cursor = days.has(todayDate) ? todayDate : addDays(todayDate, -1);
  let streak = 0;
  while (days.has(cursor)) {
    streak++;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

export function dayView(ctx: DomainContext, date: string): DayView {
  const now = localNow(ctx);
  materializeRecurring(ctx, now.date, addDays(now.date, 14));
  const a = analyze(ctx, date);
  const tasks = tasksForDate(ctx, date).sort(
    (x, y) => (x.scheduledStart ?? "~").localeCompare(y.scheduledStart ?? "~") || x.position - y.position,
  );
  const overdue = date === now.date ? overdueTasks(ctx).filter((t) => t.plannedDate !== date) : [];
  const counted = tasks.filter((t) => t.status !== "cancelled");
  const done = counted.filter((t) => t.status === "done");
  const { window, ...analysis } = a;
  return {
    date,
    today: now.date,
    now: now.dateTime,
    window: { start: fromMinutes(window.start), end: fromMinutes(window.end), isWorkDay: window.isWorkDay, source: window.source },
    plan: getDayPlan(ctx, date),
    events: eventsBetween(ctx, date, date),
    tasks,
    overdue,
    analysis,
    progress: {
      total: counted.length,
      done: done.length,
      pct: counted.length ? Math.round((done.length / counted.length) * 100) : 0,
      plannedMin: counted.reduce((s, t) => s + t.estimateMin, 0),
      doneMin: done.reduce((s, t) => s + t.estimateMin, 0),
      actualMin: done.reduce((s, t) => s + (t.actualMin ?? 0), 0),
    },
    scores: scoresFor(ctx, [...tasks, ...overdue]),
    streak: completionStreak(ctx),
  };
}
