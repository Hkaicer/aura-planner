import { z } from "zod";
import {
  zDayPlanPatch,
  zEventCreate,
  zEventPatch,
  zProjectCreate,
  zProjectPatch,
  type CalEvent,
  type DayPlan,
  type EventOccurrence,
  type MemoryNote,
  type Project,
} from "../../shared/schemas";
import { dateRange } from "../../shared/time";
import { DomainError, newId, nowIso, touch, type DomainContext } from "./context";
import { occursOn } from "./recurrence";
import { deleteTask, updateTask } from "./tasks";

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new DomainError(
      "validation",
      r.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "),
      r.error.issues,
    );
  }
  return r.data;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

const PROJECT_COLORS = ["#5b7cfa", "#2fb47c", "#e5933a", "#d9577b", "#8a6cf0", "#2aa5b8", "#a3a3a3"];

export function getProject(ctx: DomainContext, id: string): Project {
  const p = ctx.store.get("project", id);
  if (!p) throw new DomainError("not_found", `Project ${id} does not exist.`);
  return p;
}

export function findProjectByName(ctx: DomainContext, name: string): Project | null {
  const n = name.trim().toLowerCase();
  return ctx.store.all("project").find((p) => p.name.toLowerCase() === n) ?? null;
}

export function createProject(ctx: DomainContext, raw: z.input<typeof zProjectCreate> & { isDemo?: boolean }): Project {
  const input = parse(zProjectCreate, raw);
  if (findProjectByName(ctx, input.name)) throw new DomainError("conflict", `A project named "${input.name}" already exists.`);
  const count = ctx.store.all("project").length;
  const now = nowIso(ctx);
  const project: Project = {
    id: newId("p"),
    name: input.name,
    description: input.description ?? "",
    color: input.color ?? PROJECT_COLORS[count % PROJECT_COLORS.length]!,
    deadline: input.deadline ?? null,
    status: "active",
    isDemo: raw.isDemo ?? false,
    createdAt: now,
    updatedAt: now,
    rev: 1,
  };
  ctx.store.put("project", project);
  return project;
}

export function updateProject(ctx: DomainContext, id: string, raw: z.input<typeof zProjectPatch>): Project {
  const patch = parse(zProjectPatch, raw);
  const current = getProject(ctx, id);
  if (patch.name && patch.name.toLowerCase() !== current.name.toLowerCase() && findProjectByName(ctx, patch.name)) {
    throw new DomainError("conflict", `A project named "${patch.name}" already exists.`);
  }
  const next = touch(ctx, {
    ...current,
    ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
  } as Project);
  ctx.store.put("project", next);
  return next;
}

export function deleteProject(ctx: DomainContext, id: string, opts: { deleteTasks?: boolean } = {}): void {
  getProject(ctx, id);
  for (const t of ctx.store.all("task")) {
    if (t.projectId !== id) continue;
    if (!ctx.store.get("task", t.id)) continue; // already removed with its series
    if (opts.deleteTasks) deleteTask(ctx, t.id);
    else updateTask(ctx, t.id, { projectId: null });
  }
  ctx.store.remove("project", id);
}

// ---------------------------------------------------------------------------
// Events (fixed commitments, breaks and unavailable periods)
// ---------------------------------------------------------------------------

export function getEvent(ctx: DomainContext, id: string): CalEvent {
  const e = ctx.store.get("event", id);
  if (!e) throw new DomainError("not_found", `Event ${id} does not exist.`);
  return e;
}

export function createEvent(
  ctx: DomainContext,
  raw: z.input<typeof zEventCreate> & { source?: CalEvent["source"]; isDemo?: boolean },
): CalEvent {
  const input = parse(zEventCreate, raw);
  const now = nowIso(ctx);
  const event: CalEvent = {
    id: newId("e"),
    title: input.title,
    date: input.date,
    start: input.allDay ? "00:00" : input.start,
    end: input.allDay ? "23:59" : input.end,
    allDay: input.allDay ?? false,
    kind: input.kind ?? "commitment",
    location: input.location ?? "",
    notes: input.notes ?? "",
    recurrence: input.recurrence ?? null,
    source: raw.source ?? "user",
    isDemo: raw.isDemo ?? false,
    feedId: null,
    feedUid: null,
    createdAt: now,
    updatedAt: now,
    rev: 1,
  };
  ctx.store.put("event", event);
  return event;
}

export function updateEvent(ctx: DomainContext, id: string, raw: z.input<typeof zEventPatch>): CalEvent {
  const patch = parse(zEventPatch, raw);
  const current = getEvent(ctx, id);
  const next = touch(ctx, {
    ...current,
    ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
  } as CalEvent);
  if (!next.allDay && next.end <= next.start) throw new DomainError("validation", "Event end must be after its start.");
  ctx.store.put("event", next);
  return next;
}

/** Delete an event, or a single occurrence of a recurring one. */
export function deleteEvent(ctx: DomainContext, id: string, opts: { occurrenceDate?: string } = {}): void {
  const e = getEvent(ctx, id);
  if (e.recurrence && opts.occurrenceDate && opts.occurrenceDate !== e.date) {
    const exDates = [...new Set([...(e.recurrence.exDates ?? []), opts.occurrenceDate])];
    ctx.store.put("event", touch(ctx, { ...e, recurrence: { ...e.recurrence, exDates } }));
    return;
  }
  ctx.store.remove("event", id);
}

export function eventsBetween(ctx: DomainContext, from: string, to: string): EventOccurrence[] {
  const out: EventOccurrence[] = [];
  for (const e of ctx.store.all("event")) {
    if (!e.recurrence) {
      if (e.date >= from && e.date <= to) out.push({ ...e, occurrenceDate: e.date, seriesId: e.id });
      continue;
    }
    for (const d of dateRange(from > e.date ? from : e.date, to)) {
      if (occursOn(e.recurrence, e.date, d)) out.push({ ...e, occurrenceDate: d, seriesId: e.id });
    }
  }
  return out.sort((a, b) => (a.occurrenceDate + a.start).localeCompare(b.occurrenceDate + b.start));
}

// ---------------------------------------------------------------------------
// Day plans
// ---------------------------------------------------------------------------

export function emptyDayPlan(date: string): DayPlan {
  return {
    date,
    dayStart: null,
    dayEnd: null,
    intensity: "normal",
    breaks: [],
    acceptedAt: null,
    aiBrief: null,
    review: null,
    updatedAt: new Date(0).toISOString(),
    rev: 0,
  };
}

export function getDayPlan(ctx: DomainContext, date: string): DayPlan {
  return ctx.store.get("dayPlan", date) ?? emptyDayPlan(date);
}

export function patchDayPlan(ctx: DomainContext, date: string, raw: z.input<typeof zDayPlanPatch> | Partial<DayPlan>): DayPlan {
  const { breaks, acceptedAt, aiBrief, review, ...rest } = raw as Partial<DayPlan>;
  const patch = parse(zDayPlanPatch, rest);
  const current = getDayPlan(ctx, date);
  const next = touch(ctx, {
    ...current,
    ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
    ...(breaks !== undefined ? { breaks } : {}),
    ...(acceptedAt !== undefined ? { acceptedAt } : {}),
    ...(aiBrief !== undefined ? { aiBrief } : {}),
    ...(review !== undefined ? { review } : {}),
  } as DayPlan);
  if (next.dayStart && next.dayEnd && next.dayEnd <= next.dayStart) {
    throw new DomainError("validation", "The day must end after it starts.");
  }
  ctx.store.put("dayPlan", next);
  return next;
}

// ---------------------------------------------------------------------------
// Assistant memory: explicit, inspectable notes
// ---------------------------------------------------------------------------

export function addMemory(ctx: DomainContext, text: string, source: MemoryNote["source"]): MemoryNote {
  const clean = text.trim();
  if (clean.length < 3 || clean.length > 400) throw new DomainError("validation", "A memory note must be 3 to 400 characters.");
  const existing = ctx.store.all("memory").find((m) => m.text.toLowerCase() === clean.toLowerCase());
  if (existing) return existing;
  const now = nowIso(ctx);
  const note: MemoryNote = { id: newId("m"), text: clean, source, createdAt: now, updatedAt: now, rev: 1 };
  ctx.store.put("memory", note);
  return note;
}

export function removeMemory(ctx: DomainContext, id: string): void {
  if (!ctx.store.get("memory", id)) throw new DomainError("not_found", `Memory note ${id} does not exist.`);
  ctx.store.remove("memory", id);
}
