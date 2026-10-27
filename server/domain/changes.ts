import type { Change, EntityMap, EntityName, HistoryEntry, Task } from "../../shared/schemas";
import { timeOf } from "../../shared/time";
import type { Database } from "../db/database";
import { DbStore, TrackingStore, type Store } from "../db/store";
import { DomainError, newId } from "./context";

/**
 * Apply recorded changes with optimistic concurrency: every entity must still
 * be exactly as it was when the change was recorded (same revision), otherwise
 * nothing is written. Returns the changes actually performed.
 */
export function applyChanges(store: Store, changes: Change[], direction: "forward" | "inverse", nowIso: string): Change[] {
  const conflicts: string[] = [];
  for (const c of changes) {
    const expected = direction === "forward" ? c.before : c.after;
    const current = store.get(c.entity, c.id) as { rev: number } | null;
    if (expected === null) {
      if (current !== null) conflicts.push(`${c.entity} ${c.id} already exists`);
    } else if (current === null) {
      conflicts.push(`${c.entity} ${c.id} no longer exists`);
    } else if (current.rev !== (expected as { rev: number }).rev) {
      conflicts.push(`${c.entity} ${c.id} was modified since`);
    }
  }
  if (conflicts.length > 0) {
    throw new DomainError("conflict", "Some items changed since this was prepared, so nothing was applied.", conflicts);
  }
  const performed: Change[] = [];
  for (const c of changes) {
    const target = direction === "forward" ? c.after : c.before;
    const current = store.get(c.entity, c.id) as EntityMap[EntityName] | null;
    if (target === null) {
      store.remove(c.entity, c.id);
      performed.push({ ...c, op: "delete", before: current, after: null } as Change);
    } else {
      const rev = ((current as { rev: number } | null)?.rev ?? 0) + 1;
      const written = { ...target, rev, updatedAt: nowIso } as EntityMap[EntityName];
      store.put(c.entity, written as never);
      performed.push({ ...c, op: current ? "update" : "create", before: current, after: written } as Change);
    }
  }
  return performed;
}

/** Drop dependencies that point to tasks that do not exist after a partial apply. */
export function sanitizeDependencies(store: Store, changes: Change[], nowIso: string) {
  const ids = new Set(store.all("task").map((t) => t.id));
  for (const c of changes) {
    if (c.entity !== "task" || !c.after) continue;
    const t = store.get("task", c.id);
    if (!t) continue;
    const deps = t.dependsOn.filter((d) => ids.has(d));
    if (deps.length !== t.dependsOn.length) store.put("task", { ...t, dependsOn: deps, rev: t.rev + 1, updatedAt: nowIso });
  }
}

// ---------------------------------------------------------------------------
// History (undo)
// ---------------------------------------------------------------------------

const HISTORY_LIMIT = 300;

export function recordHistory(db: Database, entry: Omit<HistoryEntry, "id" | "undoneAt">): HistoryEntry {
  const full: HistoryEntry = { ...entry, id: newId("h"), undoneAt: null };
  db.run(
    "INSERT INTO history (id, label, source, changes, created_at, undone_at) VALUES (?, ?, ?, ?, ?, NULL)",
    full.id,
    full.label,
    full.source,
    JSON.stringify(full.changes),
    full.createdAt,
  );
  db.run(
    `DELETE FROM history WHERE id IN (SELECT id FROM history ORDER BY created_at DESC LIMIT -1 OFFSET ${HISTORY_LIMIT})`,
  );
  return full;
}

function rowToHistory(r: Record<string, unknown>): HistoryEntry {
  return {
    id: String(r.id),
    label: String(r.label),
    source: r.source as HistoryEntry["source"],
    changes: JSON.parse(String(r.changes)) as Change[],
    createdAt: String(r.created_at),
    undoneAt: r.undone_at ? String(r.undone_at) : null,
  };
}

export function listHistory(db: Database, limit = 50): HistoryEntry[] {
  return db.all("SELECT * FROM history ORDER BY created_at DESC LIMIT ?", limit).map(rowToHistory);
}

export function getHistory(db: Database, id: string): HistoryEntry | null {
  const r = db.get("SELECT * FROM history WHERE id = ?", id);
  return r ? rowToHistory(r) : null;
}

export function undoHistory(db: Database, id: string, nowIso: string): HistoryEntry {
  return db.tx(() => {
    const entry = getHistory(db, id);
    if (!entry) throw new DomainError("not_found", "This change no longer exists in history.");
    if (entry.undoneAt) throw new DomainError("invalid_state", "This change was already undone.");
    applyChanges(new DbStore(db), entry.changes, "inverse", nowIso);
    db.run("UPDATE history SET undone_at = ? WHERE id = ?", nowIso, id);
    db.run("UPDATE proposals SET status = 'undone', resolved_at = ? WHERE history_id = ?", nowIso, id);
    return { ...entry, undoneAt: nowIso };
  });
}

/**
 * Run a user mutation atomically and record it for undo.
 */
export function mutate<T>(
  db: Database,
  label: string | ((result: T) => string),
  source: HistoryEntry["source"],
  fn: (store: TrackingStore) => T,
  nowIso: () => string,
): { result: T; history: HistoryEntry | null } {
  return db.tx(() => {
    const store = new TrackingStore(new DbStore(db));
    const result = fn(store);
    const changes = store.getChanges();
    const history = changes.length
      ? recordHistory(db, { label: typeof label === "function" ? label(result) : label, source, changes, createdAt: nowIso() })
      : null;
    return { result, history };
  });
}

// ---------------------------------------------------------------------------
// Human-readable change descriptions
// ---------------------------------------------------------------------------

export interface ChangeSummary {
  key: string;
  entity: EntityName;
  op: Change["op"];
  title: string;
  kind: "created" | "deleted" | "completed" | "reopened" | "scheduled" | "unscheduled" | "moved" | "updated";
  details: string[];
}

function taskDetails(before: Task | null, after: Task): string[] {
  const d: string[] = [];
  if (!before) {
    if (after.scheduledStart) d.push(`${after.plannedDate} ${timeOf(after.scheduledStart)}–${after.scheduledEnd ? timeOf(after.scheduledEnd) : ""}`);
    else if (after.plannedDate) d.push(`planned ${after.plannedDate}`);
    d.push(`${after.estimateMin} min`, after.priority);
    if (after.dueAt) d.push(`due ${after.dueAt.replace("T", " ")}`);
    return d;
  }
  if (before.priority !== after.priority) d.push(`priority ${before.priority} → ${after.priority}`);
  if (before.estimateMin !== after.estimateMin) d.push(`duration ${before.estimateMin} → ${after.estimateMin} min`);
  if (before.title !== after.title) d.push(`renamed from "${before.title}"`);
  if (before.dueAt !== after.dueAt) d.push(`deadline ${before.dueAt?.replace("T", " ") ?? "none"} → ${after.dueAt?.replace("T", " ") ?? "none"}`);
  if (before.plannedDate !== after.plannedDate) d.push(`day ${before.plannedDate ?? "backlog"} → ${after.plannedDate ?? "backlog"}`);
  if (before.scheduledStart !== after.scheduledStart) {
    const b = before.scheduledStart ? timeOf(before.scheduledStart) : "unscheduled";
    const a = after.scheduledStart ? `${timeOf(after.scheduledStart)}–${after.scheduledEnd ? timeOf(after.scheduledEnd) : ""}` : "unscheduled";
    d.push(`time ${b} → ${a}`);
  }
  if (before.pinned !== after.pinned) d.push(after.pinned ? "pinned" : "unpinned");
  if (before.projectId !== after.projectId) d.push("project changed");
  if (JSON.stringify(before.dependsOn) !== JSON.stringify(after.dependsOn)) d.push("dependencies changed");
  if (JSON.stringify(before.subtasks) !== JSON.stringify(after.subtasks)) d.push("subtasks changed");
  if (before.description !== after.description || before.notes !== after.notes) d.push("notes changed");
  return d;
}

export function summarizeChange(c: Change): ChangeSummary {
  const key = `${c.entity}:${c.id}`;
  const value = (c.after ?? c.before) as unknown as Record<string, unknown>;
  const title = String(value.title ?? value.name ?? value.text ?? value.date ?? c.id);
  if (c.op === "create") {
    return { key, entity: c.entity, op: c.op, title, kind: "created", details: c.entity === "task" ? taskDetails(null, c.after as Task) : eventDetails(c) };
  }
  if (c.op === "delete") return { key, entity: c.entity, op: c.op, title, kind: "deleted", details: [] };
  if (c.entity === "task") {
    const b = c.before as Task;
    const a = c.after as Task;
    let kind: ChangeSummary["kind"] = "updated";
    if (b.status !== "done" && a.status === "done") kind = "completed";
    else if (b.status === "done" && a.status !== "done") kind = "reopened";
    else if (b.plannedDate !== a.plannedDate) kind = "moved";
    else if (b.scheduledStart !== a.scheduledStart) kind = a.scheduledStart ? (b.scheduledStart ? "moved" : "scheduled") : "unscheduled";
    return { key, entity: c.entity, op: c.op, title, kind, details: taskDetails(b, a) };
  }
  return { key, entity: c.entity, op: c.op, title, kind: "updated", details: eventDetails(c) };
}

function eventDetails(c: Change): string[] {
  if (c.entity === "event" && c.after) {
    const e = c.after as EntityMap["event"];
    return [`${e.date} ${e.start}–${e.end}`, e.kind];
  }
  if (c.entity === "dayPlan" && c.after) {
    const p = c.after as EntityMap["dayPlan"];
    const d: string[] = [];
    if (p.dayStart || p.dayEnd) d.push(`day ${p.dayStart ?? "default"}–${p.dayEnd ?? "default"}`);
    if (p.intensity !== "normal") d.push(`${p.intensity} day`);
    if (p.breaks.length) d.push(`${p.breaks.length} break(s)`);
    return d;
  }
  return [];
}

export interface ProposalClassification {
  requiresApproval: boolean;
  reason: string;
}

/** Decide whether a set of changes is minor enough to apply without asking. */
export function classifyChanges(changes: Change[]): ProposalClassification {
  const deletes = changes.filter((c) => c.op === "delete" && c.entity !== "dayPlan");
  if (deletes.length > 0) return { requiresApproval: true, reason: `Deletes ${deletes.length} item(s).` };
  const significant = changes.filter((c) => c.entity !== "memory" && c.entity !== "dayPlan");
  if (significant.length > 3) return { requiresApproval: true, reason: `Changes ${significant.length} items.` };
  const timeChanges = changes.filter(
    (c) =>
      c.entity === "task" &&
      c.op === "update" &&
      ((c.before as Task).scheduledStart !== (c.after as Task).scheduledStart || (c.before as Task).plannedDate !== (c.after as Task).plannedDate),
  );
  if (timeChanges.length > 1) return { requiresApproval: true, reason: `Reschedules ${timeChanges.length} tasks.` };
  const reopened = changes.filter((c) => c.entity === "task" && c.op === "update" && (c.before as Task).status === "done" && (c.after as Task).status !== "done");
  if (reopened.length > 0) return { requiresApproval: true, reason: "Reopens a completed task." };
  const dayPlan = changes.find((c) => c.entity === "dayPlan");
  if (dayPlan && significant.length > 1) return { requiresApproval: true, reason: "Changes the shape of your day." };
  return { requiresApproval: false, reason: "Minor change." };
}
