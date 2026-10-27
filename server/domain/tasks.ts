import {
  zTaskCreate,
  zTaskPatch,
  type Subtask,
  type Task,
  type TaskCreate,
  type TaskPatch,
} from "../../shared/schemas";
import { addDays, addMinutesToDateTime, combine, dateOf, dateRange, timeOf } from "../../shared/time";
import { DomainError, localNow, newId, nowIso, today, touch, type DomainContext } from "./context";
import { occursOn } from "./recurrence";

export const isTemplate = (t: Task) => t.recurrence !== null && t.recurrenceParentId === null;
export const isOpen = (t: Task) => t.status !== "done" && t.status !== "cancelled";

export function getTask(ctx: DomainContext, id: string): Task {
  const t = ctx.store.get("task", id);
  if (!t) throw new DomainError("not_found", `Task ${id} does not exist.`);
  return t;
}

function parseOrThrow<T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    throw new DomainError("validation", msg, r.error.issues);
  }
  return r.data;
}

function assertProject(ctx: DomainContext, projectId: string | null | undefined) {
  if (projectId && !ctx.store.get("project", projectId)) {
    throw new DomainError("validation", `Project ${projectId} does not exist.`);
  }
}

/** Throws when adding `deps` to `taskId` would reference unknown tasks or create a cycle. */
function assertDependencies(ctx: DomainContext, taskId: string, deps: string[]) {
  const all = new Map(ctx.store.all("task").map((t) => [t.id, t]));
  for (const d of deps) {
    if (d === taskId) throw new DomainError("validation", "A task cannot depend on itself.");
    if (!all.has(d)) throw new DomainError("validation", `Dependency ${d} does not exist.`);
  }
  // Depth-first search from each dependency looking for taskId.
  const seen = new Set<string>();
  const stack = [...deps];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === taskId) throw new DomainError("validation", "This dependency would create a cycle.");
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(all.get(id)?.dependsOn ?? []));
  }
}

function nextPosition(ctx: DomainContext): number {
  let max = 0;
  for (const t of ctx.store.all("task")) max = Math.max(max, t.position);
  return max + 1;
}

function withSchedule(t: Task): Task {
  if (!t.scheduledStart) return { ...t, scheduledEnd: null };
  const end = addMinutesToDateTime(t.scheduledStart, t.estimateMin);
  return { ...t, plannedDate: dateOf(t.scheduledStart), scheduledEnd: dateOf(end) === dateOf(t.scheduledStart) ? end : `${dateOf(t.scheduledStart)}T23:59` };
}

export function createTask(ctx: DomainContext, raw: TaskCreate & { source?: Task["source"]; isDemo?: boolean }): Task {
  const input = parseOrThrow(zTaskCreate, raw);
  assertProject(ctx, input.projectId);
  const id = newId("t");
  const deps = [...new Set(input.dependsOn ?? [])];
  if (deps.length) assertDependencies(ctx, id, deps);
  const now = nowIso(ctx);
  const subtasks: Subtask[] = (input.subtasks ?? []).map((title) => ({ id: newId("s", 6), title, done: false }));
  const plannedDate = input.scheduledStart ? dateOf(input.scheduledStart) : (input.plannedDate ?? null);
  let task: Task = {
    id,
    title: input.title,
    description: input.description ?? "",
    status: input.status ?? "todo",
    priority: input.priority ?? "medium",
    estimateMin: input.estimateMin ?? ctx.settings.defaultEstimateMin,
    actualMin: null,
    startDate: input.startDate ?? null,
    dueAt: input.dueAt ?? null,
    dueHard: input.dueHard ?? true,
    plannedDate,
    scheduledStart: input.scheduledStart ?? null,
    scheduledEnd: null,
    pinned: input.scheduledStart ? (input.pinned ?? true) : false,
    energy: input.energy ?? "medium",
    projectId: input.projectId ?? null,
    category: input.category ?? null,
    tags: [...new Set(input.tags ?? [])],
    subtasks,
    dependsOn: deps,
    recurrence: input.recurrence ?? null,
    recurrenceParentId: null,
    notes: input.notes ?? "",
    links: input.links ?? [],
    postponedCount: 0,
    position: nextPosition(ctx),
    source: raw.source ?? "user",
    isDemo: raw.isDemo ?? false,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    rev: 1,
  };
  if (task.status === "done") task.completedAt = now;
  const rule = task.recurrence;
  if (rule) {
    // A recurring task is a template: it is anchored on a date and spawns instances.
    task = { ...task, plannedDate: plannedDate ?? today(ctx), status: "todo" };
    if (task.scheduledStart && !rule.time) task.recurrence = { ...rule, time: timeOf(task.scheduledStart) };
    task.scheduledStart = null;
    task.pinned = false;
  }
  task = withSchedule(task);
  ctx.store.put("task", task);
  if (task.recurrence) materializeRecurring(ctx, today(ctx), addDays(today(ctx), 14));
  return ctx.store.get("task", id)!;
}

const PROPAGATED: (keyof Task)[] = ["title", "description", "priority", "estimateMin", "energy", "projectId", "category", "tags", "notes"];

export function updateTask(ctx: DomainContext, id: string, raw: TaskPatch): Task {
  const patch = parseOrThrow(zTaskPatch, raw);
  const current = getTask(ctx, id);
  if (patch.projectId !== undefined) assertProject(ctx, patch.projectId);
  if (patch.dependsOn) assertDependencies(ctx, id, [...new Set(patch.dependsOn)]);

  let next: Task = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    (next as unknown as Record<string, unknown>)[key] = value;
  }
  if (patch.tags) next.tags = [...new Set(patch.tags)];
  if (patch.dependsOn) next.dependsOn = [...new Set(patch.dependsOn)];

  // Status transitions keep completion timestamps consistent.
  if (patch.status && patch.status !== current.status) {
    if (patch.status === "done") next.completedAt = nowIso(ctx);
    else if (current.status === "done") next.completedAt = null;
  }

  // Scheduling rules.
  if (patch.scheduledStart === null) {
    next.scheduledStart = null;
    next.scheduledEnd = null;
    if (patch.pinned === undefined) next.pinned = false;
  } else if (patch.scheduledStart) {
    next.plannedDate = dateOf(patch.scheduledStart);
  } else if (patch.plannedDate !== undefined && patch.plannedDate !== current.plannedDate) {
    if (next.scheduledStart && (patch.plannedDate === null || dateOf(next.scheduledStart) !== patch.plannedDate)) {
      next.scheduledStart = null;
      next.scheduledEnd = null;
      next.pinned = false;
    }
  }
  if (next.plannedDate && current.plannedDate && next.plannedDate > current.plannedDate && isOpen(current)) {
    next.postponedCount = current.postponedCount + 1;
  }
  if (patch.scheduledEnd && next.scheduledStart) {
    if (patch.scheduledEnd <= next.scheduledStart) throw new DomainError("validation", "The end must be after the start.");
    if (dateOf(patch.scheduledEnd) !== dateOf(next.scheduledStart)) throw new DomainError("validation", "A scheduled block must end on the same day.");
    const minutes = Math.round((Date.parse(patch.scheduledEnd + ":00Z") - Date.parse(next.scheduledStart + ":00Z")) / 60000);
    next.estimateMin = Math.min(720, Math.max(5, minutes));
    next.scheduledEnd = patch.scheduledEnd;
  } else {
    next = withSchedule(next);
  }
  if (isTemplate(next)) {
    next.scheduledStart = null;
    next.scheduledEnd = null;
  }
  next = touch(ctx, next);
  ctx.store.put("task", next);

  if (isTemplate(current)) propagateTemplate(ctx, current, next);
  return next;
}

function propagateTemplate(ctx: DomainContext, before: Task, after: Task) {
  const changed = PROPAGATED.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  const from = today(ctx);
  if (changed.length === 0 && JSON.stringify(before.recurrence) === JSON.stringify(after.recurrence)) return;
  for (const inst of ctx.store.all("task")) {
    if (inst.recurrenceParentId !== after.id || !isOpen(inst) || (inst.plannedDate ?? "") < from) continue;
    if (after.recurrence && inst.plannedDate && !occursOn(after.recurrence, after.plannedDate ?? from, inst.plannedDate)) {
      ctx.store.remove("task", inst.id);
      continue;
    }
    const patched: Task = { ...inst };
    for (const k of changed) (patched as unknown as Record<string, unknown>)[k] = after[k];
    ctx.store.put("task", withSchedule(touch(ctx, patched)));
  }
  materializeRecurring(ctx, from, addDays(from, 14));
}

export function completeTask(ctx: DomainContext, id: string, opts: { actualMin?: number | null } = {}): Task {
  const t = getTask(ctx, id);
  if (isTemplate(t)) throw new DomainError("invalid_state", "Complete an occurrence of a recurring task, not the series.");
  if (t.status === "done") return t;
  const patch: TaskPatch = { status: "done" };
  if (opts.actualMin !== undefined && opts.actualMin !== null) patch.actualMin = opts.actualMin;
  return updateTask(ctx, id, patch);
}

export function reopenTask(ctx: DomainContext, id: string): Task {
  const t = getTask(ctx, id);
  if (t.status !== "done" && t.status !== "cancelled") return t;
  return updateTask(ctx, id, { status: "todo" });
}

export function startTask(ctx: DomainContext, id: string): Task {
  const t = getTask(ctx, id);
  if (t.status === "done") throw new DomainError("invalid_state", "This task is already completed.");
  for (const other of ctx.store.all("task")) {
    if (other.id !== id && other.status === "in_progress") updateTask(ctx, other.id, { status: "todo" });
  }
  return updateTask(ctx, id, { status: "in_progress" });
}

export function deleteTask(ctx: DomainContext, id: string): void {
  const t = getTask(ctx, id);
  const all = ctx.store.all("task");
  const removed = new Set([id]);
  if (isTemplate(t)) {
    for (const inst of all) {
      if (inst.recurrenceParentId !== id) continue;
      if (isOpen(inst) && (inst.plannedDate ?? "") >= today(ctx)) {
        ctx.store.remove("task", inst.id);
        removed.add(inst.id);
      } else ctx.store.put("task", touch(ctx, { ...inst, recurrenceParentId: null }));
    }
  } else if (t.recurrenceParentId && t.plannedDate) {
    const tpl = ctx.store.get("task", t.recurrenceParentId);
    const origDate = id.split("~")[1] ?? t.plannedDate;
    if (tpl?.recurrence) {
      ctx.store.put("task", touch(ctx, { ...tpl, recurrence: { ...tpl.recurrence, exDates: [...new Set([...tpl.recurrence.exDates, origDate])] } }));
    }
  }
  ctx.store.remove("task", id);
  for (const other of ctx.store.all("task")) {
    if (other.dependsOn.some((d) => removed.has(d))) {
      ctx.store.put("task", touch(ctx, { ...other, dependsOn: other.dependsOn.filter((d) => !removed.has(d)) }));
    }
  }
}

export function scheduleTask(ctx: DomainContext, id: string, date: string, start: string, opts: { pin?: boolean } = {}): Task {
  return updateTask(ctx, id, { scheduledStart: combine(date, start), pinned: opts.pin ?? true });
}

export function moveTask(ctx: DomainContext, id: string, date: string, opts: { keepTime?: boolean } = {}): Task {
  const t = getTask(ctx, id);
  if (opts.keepTime && t.scheduledStart) {
    return updateTask(ctx, id, { scheduledStart: combine(date, timeOf(t.scheduledStart)), pinned: t.pinned });
  }
  return updateTask(ctx, id, { plannedDate: date, scheduledStart: null, pinned: false });
}

export function unscheduleTask(ctx: DomainContext, id: string, opts: { toBacklog?: boolean } = {}): Task {
  const patch: TaskPatch = { scheduledStart: null, pinned: false };
  if (opts.toBacklog) patch.plannedDate = null;
  return updateTask(ctx, id, patch);
}

export function reorderTasks(ctx: DomainContext, ids: string[]): void {
  const tasks = ids.map((id) => getTask(ctx, id));
  const positions = tasks.map((t) => t.position).sort((a, b) => a - b);
  tasks.forEach((t, i) => {
    const position = positions[i] ?? i;
    if (t.position !== position) ctx.store.put("task", touch(ctx, { ...t, position }));
  });
}

export function setDependency(ctx: DomainContext, taskId: string, dependsOnId: string, remove = false): Task {
  const t = getTask(ctx, taskId);
  const deps = remove ? t.dependsOn.filter((d) => d !== dependsOnId) : [...new Set([...t.dependsOn, dependsOnId])];
  return updateTask(ctx, taskId, { dependsOn: deps });
}

export function editSubtasks(
  ctx: DomainContext,
  taskId: string,
  ops: { add?: string[]; toggle?: string[]; complete?: string[]; remove?: string[]; rename?: { id: string; title: string }[] },
): Task {
  const t = getTask(ctx, taskId);
  let subtasks = [...t.subtasks];
  const exists = (id: string) => {
    if (!subtasks.some((s) => s.id === id)) throw new DomainError("validation", `Subtask ${id} does not exist on this task.`);
  };
  for (const id of ops.remove ?? []) {
    exists(id);
    subtasks = subtasks.filter((s) => s.id !== id);
  }
  for (const id of ops.toggle ?? []) {
    exists(id);
    subtasks = subtasks.map((s) => (s.id === id ? { ...s, done: !s.done } : s));
  }
  for (const id of ops.complete ?? []) {
    exists(id);
    subtasks = subtasks.map((s) => (s.id === id ? { ...s, done: true } : s));
  }
  for (const r of ops.rename ?? []) {
    exists(r.id);
    subtasks = subtasks.map((s) => (s.id === r.id ? { ...s, title: r.title } : s));
  }
  for (const title of ops.add ?? []) subtasks.push({ id: newId("s", 6), title, done: false });
  return updateTask(ctx, taskId, { subtasks });
}

/** Create missing occurrences of recurring templates between two dates. */
export function materializeRecurring(ctx: DomainContext, from: string, to: string): number {
  const start = from < today(ctx) ? today(ctx) : from;
  if (to < start) return 0;
  const all = ctx.store.all("task");
  const existing = new Set(all.map((t) => t.id));
  let created = 0;
  for (const tpl of all) {
    if (!isTemplate(tpl) || !tpl.recurrence) continue;
    const anchor = tpl.plannedDate ?? dateOf(tpl.createdAt);
    for (const date of dateRange(start, to)) {
      if (!occursOn(tpl.recurrence, anchor, date)) continue;
      const id = `${tpl.id}~${date}`;
      if (existing.has(id)) continue;
      const now = nowIso(ctx);
      const time = tpl.recurrence.time ?? null;
      const inst: Task = withSchedule({
        ...tpl,
        id,
        status: "todo",
        plannedDate: date,
        scheduledStart: time ? combine(date, time) : null,
        scheduledEnd: null,
        pinned: Boolean(time),
        recurrence: null,
        recurrenceParentId: tpl.id,
        subtasks: tpl.subtasks.map((s) => ({ ...s, done: false })),
        dependsOn: [],
        postponedCount: 0,
        source: "recurrence",
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        actualMin: null,
        rev: 1,
      });
      ctx.store.put("task", inst);
      existing.add(id);
      created++;
    }
  }
  return created;
}

export function tasksForDate(ctx: DomainContext, date: string): Task[] {
  return ctx.store
    .all("task")
    .filter((t) => !isTemplate(t) && (t.plannedDate === date || (t.scheduledStart && dateOf(t.scheduledStart) === date)));
}

/** Open tasks left behind on earlier days, or past their deadline. */
export function overdueTasks(ctx: DomainContext): Task[] {
  const now = localNow(ctx);
  return ctx.store
    .all("task")
    .filter(
      (t) =>
        !isTemplate(t) &&
        isOpen(t) &&
        t.status !== "inbox" &&
        ((t.plannedDate !== null && t.plannedDate < now.date) || (t.dueAt !== null && t.dueAt < now.dateTime && t.plannedDate !== now.date)),
    );
}
