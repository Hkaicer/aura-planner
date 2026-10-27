import type { CalEvent, Change, DayPlan, EntityMap, EntityName, MemoryNote, Project, Task } from "../../shared/schemas";
import type { Database, Row } from "./database";

/**
 * Entity storage used by every domain operation. Domain code never writes SQL:
 * it reads and writes whole entities through a Store, which lets the same
 * operations run against the real database or against an in-memory overlay
 * (used to stage AI proposals without touching user data).
 */
export interface Store {
  get<E extends EntityName>(entity: E, id: string): EntityMap[E] | null;
  all<E extends EntityName>(entity: E): EntityMap[E][];
  put<E extends EntityName>(entity: E, value: EntityMap[E]): void;
  remove<E extends EntityName>(entity: E, id: string): void;
}

export function keyOf<E extends EntityName>(entity: E, value: EntityMap[E]): string {
  return entity === "dayPlan" ? (value as DayPlan).date : (value as { id: string }).id;
}

const json = (v: unknown) => JSON.stringify(v);
const parse = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== "string" || v === "") return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};
const bool = (v: unknown) => v === 1 || v === 1n || v === true;
const num = (v: unknown) => (typeof v === "bigint" ? Number(v) : (v as number));
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

function rowToTask(r: Row): Task {
  return {
    id: String(r.id),
    title: String(r.title),
    description: String(r.description ?? ""),
    status: r.status as Task["status"],
    priority: r.priority as Task["priority"],
    estimateMin: num(r.estimate_min),
    actualMin: r.actual_min === null ? null : num(r.actual_min),
    startDate: str(r.start_date),
    dueAt: str(r.due_at),
    dueHard: bool(r.due_hard),
    plannedDate: str(r.planned_date),
    scheduledStart: str(r.scheduled_start),
    scheduledEnd: str(r.scheduled_end),
    pinned: bool(r.pinned),
    energy: r.energy as Task["energy"],
    projectId: str(r.project_id),
    category: str(r.category),
    tags: parse(r.tags, []),
    subtasks: parse(r.subtasks, []),
    dependsOn: parse(r.depends_on, []),
    recurrence: parse(r.recurrence, null),
    recurrenceParentId: str(r.recurrence_parent_id),
    notes: String(r.notes ?? ""),
    links: parse(r.links, []),
    postponedCount: num(r.postponed_count),
    position: num(r.position),
    source: r.source as Task["source"],
    isDemo: bool(r.is_demo),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    completedAt: str(r.completed_at),
    rev: num(r.rev),
  };
}

function taskParams(t: Task) {
  return [
    t.id, t.title, t.description, t.status, t.priority, t.estimateMin, t.actualMin, t.startDate, t.dueAt,
    t.dueHard ? 1 : 0, t.plannedDate, t.scheduledStart, t.scheduledEnd, t.pinned ? 1 : 0, t.energy, t.projectId,
    t.category, json(t.tags), json(t.subtasks), json(t.dependsOn), t.recurrence ? json(t.recurrence) : null,
    t.recurrenceParentId, t.notes, json(t.links), t.postponedCount, t.position, t.source, t.isDemo ? 1 : 0,
    t.createdAt, t.updatedAt, t.completedAt, t.rev,
  ] as const;
}

const TASK_COLUMNS =
  "id, title, description, status, priority, estimate_min, actual_min, start_date, due_at, due_hard, planned_date, scheduled_start, scheduled_end, pinned, energy, project_id, category, tags, subtasks, depends_on, recurrence, recurrence_parent_id, notes, links, postponed_count, position, source, is_demo, created_at, updated_at, completed_at, rev";

function rowToProject(r: Row): Project {
  return {
    id: String(r.id),
    name: String(r.name),
    description: String(r.description ?? ""),
    color: String(r.color),
    deadline: str(r.deadline),
    status: r.status as Project["status"],
    isDemo: bool(r.is_demo),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    rev: num(r.rev),
  };
}

function rowToEvent(r: Row): CalEvent {
  return {
    id: String(r.id),
    title: String(r.title),
    date: String(r.date),
    start: String(r.start),
    end: String(r.end),
    allDay: bool(r.all_day),
    kind: r.kind as CalEvent["kind"],
    location: String(r.location ?? ""),
    notes: String(r.notes ?? ""),
    recurrence: parse(r.recurrence, null),
    source: r.source as CalEvent["source"],
    isDemo: bool(r.is_demo),
    feedId: str(r.feed_id),
    feedUid: str(r.feed_uid),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    rev: num(r.rev),
  };
}

function rowToDayPlan(r: Row): DayPlan {
  const data = parse<Partial<DayPlan>>(r.data, {});
  return {
    date: String(r.date),
    dayStart: data.dayStart ?? null,
    dayEnd: data.dayEnd ?? null,
    intensity: data.intensity ?? "normal",
    breaks: data.breaks ?? [],
    acceptedAt: data.acceptedAt ?? null,
    aiBrief: data.aiBrief ?? null,
    review: data.review ?? null,
    updatedAt: String(r.updated_at),
    rev: num(r.rev),
  };
}

function rowToMemory(r: Row): MemoryNote {
  return {
    id: String(r.id),
    text: String(r.text),
    source: r.source as MemoryNote["source"],
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    rev: num(r.rev),
  };
}

export class DbStore implements Store {
  constructor(private readonly db: Database) {}

  get<E extends EntityName>(entity: E, id: string): EntityMap[E] | null {
    switch (entity) {
      case "task": {
        const r = this.db.get("SELECT * FROM tasks WHERE id = ?", id);
        return (r ? rowToTask(r) : null) as EntityMap[E] | null;
      }
      case "project": {
        const r = this.db.get("SELECT * FROM projects WHERE id = ?", id);
        return (r ? rowToProject(r) : null) as EntityMap[E] | null;
      }
      case "event": {
        const r = this.db.get("SELECT * FROM events WHERE id = ?", id);
        return (r ? rowToEvent(r) : null) as EntityMap[E] | null;
      }
      case "dayPlan": {
        const r = this.db.get("SELECT * FROM day_plans WHERE date = ?", id);
        return (r ? rowToDayPlan(r) : null) as EntityMap[E] | null;
      }
      case "memory": {
        const r = this.db.get("SELECT * FROM memory WHERE id = ?", id);
        return (r ? rowToMemory(r) : null) as EntityMap[E] | null;
      }
    }
    return null;
  }

  all<E extends EntityName>(entity: E): EntityMap[E][] {
    switch (entity) {
      case "task":
        return this.db.all("SELECT * FROM tasks ORDER BY position, created_at").map(rowToTask) as EntityMap[E][];
      case "project":
        return this.db.all("SELECT * FROM projects ORDER BY created_at").map(rowToProject) as EntityMap[E][];
      case "event":
        return this.db.all("SELECT * FROM events ORDER BY date, start").map(rowToEvent) as EntityMap[E][];
      case "dayPlan":
        return this.db.all("SELECT * FROM day_plans ORDER BY date").map(rowToDayPlan) as EntityMap[E][];
      case "memory":
        return this.db.all("SELECT * FROM memory ORDER BY created_at").map(rowToMemory) as EntityMap[E][];
    }
    return [];
  }

  put<E extends EntityName>(entity: E, value: EntityMap[E]): void {
    switch (entity) {
      case "task": {
        const t = value as Task;
        const params = taskParams(t);
        const placeholders = params.map(() => "?").join(", ");
        const updates = TASK_COLUMNS.split(", ")
          .slice(1)
          .map((c) => `${c} = excluded.${c}`)
          .join(", ");
        this.db.run(`INSERT INTO tasks (${TASK_COLUMNS}) VALUES (${placeholders}) ON CONFLICT(id) DO UPDATE SET ${updates}`, ...params);
        return;
      }
      case "project": {
        const p = value as Project;
        this.db.run(
          `INSERT INTO projects (id, name, description, color, deadline, status, is_demo, created_at, updated_at, rev)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, color = excluded.color,
             deadline = excluded.deadline, status = excluded.status, is_demo = excluded.is_demo,
             created_at = excluded.created_at, updated_at = excluded.updated_at, rev = excluded.rev`,
          p.id, p.name, p.description, p.color, p.deadline, p.status, p.isDemo ? 1 : 0, p.createdAt, p.updatedAt, p.rev,
        );
        return;
      }
      case "event": {
        const e = value as CalEvent;
        this.db.run(
          `INSERT INTO events (id, title, date, start, end, all_day, kind, location, notes, recurrence, source, is_demo, feed_id, feed_uid, created_at, updated_at, rev)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET title = excluded.title, date = excluded.date, start = excluded.start, end = excluded.end,
             all_day = excluded.all_day, kind = excluded.kind, location = excluded.location, notes = excluded.notes,
             recurrence = excluded.recurrence, source = excluded.source, is_demo = excluded.is_demo,
             feed_id = excluded.feed_id, feed_uid = excluded.feed_uid,
             created_at = excluded.created_at, updated_at = excluded.updated_at, rev = excluded.rev`,
          e.id, e.title, e.date, e.start, e.end, e.allDay ? 1 : 0, e.kind, e.location, e.notes,
          e.recurrence ? json(e.recurrence) : null, e.source, e.isDemo ? 1 : 0, e.feedId ?? null, e.feedUid ?? null,
          e.createdAt, e.updatedAt, e.rev,
        );
        return;
      }
      case "dayPlan": {
        const d = value as DayPlan;
        const { date, updatedAt, rev, ...data } = d;
        this.db.run(
          `INSERT INTO day_plans (date, data, updated_at, rev) VALUES (?, ?, ?, ?)
           ON CONFLICT(date) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, rev = excluded.rev`,
          date, json(data), updatedAt, rev,
        );
        return;
      }
      case "memory": {
        const m = value as MemoryNote;
        this.db.run(
          `INSERT INTO memory (id, text, source, created_at, updated_at, rev) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET text = excluded.text, source = excluded.source, updated_at = excluded.updated_at, rev = excluded.rev`,
          m.id, m.text, m.source, m.createdAt, m.updatedAt, m.rev,
        );
        return;
      }
    }
  }

  remove<E extends EntityName>(entity: E, id: string): void {
    const table = { task: "tasks", project: "projects", event: "events", dayPlan: "day_plans", memory: "memory" }[entity];
    const key = entity === "dayPlan" ? "date" : "id";
    this.db.run(`DELETE FROM ${table} WHERE ${key} = ?`, id);
  }
}

const clone = <T>(v: T): T => (v === null || v === undefined ? v : structuredClone(v));

/**
 * Records every change made through it (first "before", latest "after").
 * Wraps the real database for user actions so they can be undone.
 */
export class TrackingStore implements Store {
  private readonly changes = new Map<string, Change>();

  constructor(protected readonly base: Store) {}

  get<E extends EntityName>(entity: E, id: string): EntityMap[E] | null {
    return clone(this.base.get(entity, id));
  }

  all<E extends EntityName>(entity: E): EntityMap[E][] {
    return this.base.all(entity).map(clone);
  }

  private record<E extends EntityName>(entity: E, id: string, after: EntityMap[E] | null) {
    const key = `${entity}:${id}`;
    const existing = this.changes.get(key);
    const before = existing ? existing.before : clone(this.base.get(entity, id));
    if (before === null && after === null) {
      this.changes.delete(key);
      return;
    }
    const op: Change["op"] = before === null ? "create" : after === null ? "delete" : "update";
    this.changes.set(key, { entity, id, op, before, after: clone(after) } as Change);
  }

  put<E extends EntityName>(entity: E, value: EntityMap[E]): void {
    const id = keyOf(entity, value);
    this.record(entity, id, value);
    this.base.put(entity, value);
  }

  remove<E extends EntityName>(entity: E, id: string): void {
    this.record(entity, id, null);
    this.base.remove(entity, id);
  }

  getChanges(): Change[] {
    return [...this.changes.values()].filter((c) => JSON.stringify(c.before) !== JSON.stringify(c.after));
  }
}

/**
 * Copy-on-write layer over a read-only base store. Used for AI runs: the agent
 * works on a private view of the data; nothing reaches SQLite until the user
 * (or the auto-apply policy) accepts the resulting proposal.
 */
export class OverlayStore implements Store {
  private readonly overlay = new Map<string, unknown | null>();
  private readonly baseline = new Map<string, unknown | null>();

  constructor(private readonly base: Store) {}

  private k(entity: EntityName, id: string) {
    return `${entity}:${id}`;
  }

  get<E extends EntityName>(entity: E, id: string): EntityMap[E] | null {
    const key = this.k(entity, id);
    if (this.overlay.has(key)) return clone(this.overlay.get(key) as EntityMap[E] | null);
    return clone(this.base.get(entity, id));
  }

  all<E extends EntityName>(entity: E): EntityMap[E][] {
    const result = new Map<string, EntityMap[E]>();
    for (const v of this.base.all(entity)) result.set(keyOf(entity, v), v);
    for (const [key, value] of this.overlay) {
      const [e, ...rest] = key.split(":");
      if (e !== entity) continue;
      const id = rest.join(":");
      if (value === null) result.delete(id);
      else result.set(id, value as EntityMap[E]);
    }
    return [...result.values()].map(clone);
  }

  private remember(entity: EntityName, id: string) {
    const key = this.k(entity, id);
    if (!this.baseline.has(key)) this.baseline.set(key, clone(this.base.get(entity, id)));
  }

  put<E extends EntityName>(entity: E, value: EntityMap[E]): void {
    const id = keyOf(entity, value);
    this.remember(entity, id);
    this.overlay.set(this.k(entity, id), clone(value));
  }

  remove<E extends EntityName>(entity: E, id: string): void {
    this.remember(entity, id);
    this.overlay.set(this.k(entity, id), null);
  }

  /** Capture the overlay so a failed tool call can be rolled back. */
  snapshot(): { overlay: Map<string, unknown | null>; baseline: Map<string, unknown | null> } {
    return { overlay: new Map(this.overlay), baseline: new Map(this.baseline) };
  }

  restore(s: { overlay: Map<string, unknown | null>; baseline: Map<string, unknown | null> }) {
    this.overlay.clear();
    for (const [k, v] of s.overlay) this.overlay.set(k, v);
    this.baseline.clear();
    for (const [k, v] of s.baseline) this.baseline.set(k, v);
  }

  getChanges(): Change[] {
    const out: Change[] = [];
    for (const [key, after] of this.overlay) {
      const [entity, ...rest] = key.split(":");
      const id = rest.join(":");
      const before = this.baseline.get(key) ?? null;
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      if (before === null && after === null) continue;
      const op: Change["op"] = before === null ? "create" : after === null ? "delete" : "update";
      out.push({ entity: entity as EntityName, id, op, before, after } as Change);
    }
    return out;
  }
}
