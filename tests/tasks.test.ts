import { describe, expect, it } from "vitest";
import { DbStore } from "../server/db/store";
import { mutate, undoHistory } from "../server/domain/changes";
import { DomainError } from "../server/domain/context";
import { createEvent, createProject, deleteProject, eventsBetween } from "../server/domain/entities";
import { applyPlan, computePlan, dayView, distributeTasks, findFreeTime } from "../server/domain/planning";
import {
  completeTask,
  createTask,
  deleteTask,
  editSubtasks,
  materializeRecurring,
  moveTask,
  reopenTask,
  scheduleTask,
  setDependency,
  updateTask,
} from "../server/domain/tasks";
import { clockAt, dbCtx, memoryDb, testSettings } from "./helpers";

const clock = clockAt("2026-10-26T08:00");

describe("task operations", () => {
  it("creates, updates, completes and reopens a task with consistent timestamps", () => {
    const db = memoryDb();
    const ctx = dbCtx(db, clock);
    const t = createTask(ctx, { title: "Write report", estimateMin: 90, priority: "high", plannedDate: "2026-10-26" });
    expect(t.status).toBe("todo");
    expect(t.rev).toBe(1);
    const u = updateTask(ctx, t.id, { priority: "critical", estimateMin: 60 });
    expect(u.priority).toBe("critical");
    expect(u.rev).toBe(2);
    const done = completeTask(ctx, t.id, { actualMin: 75 });
    expect(done.status).toBe("done");
    expect(done.completedAt).not.toBeNull();
    expect(done.actualMin).toBe(75);
    const back = reopenTask(ctx, t.id);
    expect(back.completedAt).toBeNull();
  });

  it("rejects invalid writes with validation errors", () => {
    const ctx = dbCtx(memoryDb(), clock);
    expect(() => createTask(ctx, { title: "" })).toThrow(DomainError);
    expect(() => createTask(ctx, { title: "x", estimateMin: 2 })).toThrow(/estimateMin/);
    expect(() => createTask(ctx, { title: "x", plannedDate: "2026-02-30" })).toThrow(/date/);
    expect(() => createTask(ctx, { title: "x", projectId: "p_missing" })).toThrow(/does not exist/);
    expect(() => updateTask(ctx, "t_missing", { title: "y" })).toThrow(/does not exist/);
  });

  it("scheduling sets the end from the estimate and keeps the day consistent", () => {
    const ctx = dbCtx(memoryDb(), clock);
    const t = createTask(ctx, { title: "Gym", estimateMin: 60 });
    const s = scheduleTask(ctx, t.id, "2026-10-27", "18:00");
    expect(s).toMatchObject({ plannedDate: "2026-10-27", scheduledStart: "2026-10-27T18:00", scheduledEnd: "2026-10-27T19:00", pinned: true });
    const longer = updateTask(ctx, t.id, { estimateMin: 90 });
    expect(longer.scheduledEnd).toBe("2026-10-27T19:30");
  });

  it("moving to a later day counts as a postponement and keeps the deadline", () => {
    const ctx = dbCtx(memoryDb(), clock);
    const t = createTask(ctx, { title: "Essay", plannedDate: "2026-10-26", dueAt: "2026-10-30T18:00", scheduledStart: "2026-10-26T10:00" });
    const m = moveTask(ctx, t.id, "2026-10-27");
    expect(m.postponedCount).toBe(1);
    expect(m.dueAt).toBe("2026-10-30T18:00");
    expect(m.scheduledStart).toBeNull();
  });

  it("rejects dependency cycles and cleans dependencies on delete", () => {
    const ctx = dbCtx(memoryDb(), clock);
    const a = createTask(ctx, { title: "A" });
    const b = createTask(ctx, { title: "B", dependsOn: [a.id] });
    expect(() => setDependency(ctx, a.id, b.id)).toThrow(/cycle/);
    expect(() => setDependency(ctx, a.id, a.id)).toThrow(/itself/);
    deleteTask(ctx, a.id);
    expect(ctx.store.get("task", b.id)!.dependsOn).toEqual([]);
  });

  it("manages subtasks", () => {
    const ctx = dbCtx(memoryDb(), clock);
    const t = createTask(ctx, { title: "Apply", subtasks: ["One", "Two"] });
    const toggled = editSubtasks(ctx, t.id, { toggle: [t.subtasks[0]!.id], add: ["Three"] });
    expect(toggled.subtasks.map((s) => [s.title, s.done])).toEqual([
      ["One", true],
      ["Two", false],
      ["Three", false],
    ]);
    expect(() => editSubtasks(ctx, t.id, { remove: ["nope"] })).toThrow(/Subtask/);
  });

  it("materializes recurring tasks once and remembers deleted occurrences", () => {
    const ctx = dbCtx(memoryDb(), clock);
    const tpl = createTask(ctx, {
      title: "Gym",
      estimateMin: 60,
      plannedDate: "2026-10-26",
      recurrence: { freq: "weekly", interval: 1, byWeekday: [1, 3, 5], time: "18:30", exDates: [] },
    });
    const instances = () => ctx.store.all("task").filter((t) => t.recurrenceParentId === tpl.id);
    const firstCount = instances().length;
    expect(firstCount).toBeGreaterThanOrEqual(6); // Mon/Wed/Fri over two weeks
    expect(instances()[0]).toMatchObject({ pinned: true, scheduledStart: "2026-10-26T18:30" });
    materializeRecurring(ctx, "2026-10-26", "2026-11-09");
    expect(instances().length).toBe(firstCount);
    const wed = instances().find((t) => t.plannedDate === "2026-10-28")!;
    deleteTask(ctx, wed.id);
    materializeRecurring(ctx, "2026-10-26", "2026-11-09");
    expect(instances().find((t) => t.plannedDate === "2026-10-28")).toBeUndefined();
    // Editing the series updates future open occurrences.
    updateTask(ctx, tpl.id, { estimateMin: 45 });
    expect(instances().every((t) => t.estimateMin === 45)).toBe(true);
  });

  it("deleting a project keeps its tasks unless asked otherwise", () => {
    const ctx = dbCtx(memoryDb(), clock);
    const p = createProject(ctx, { name: "Thesis" });
    const t = createTask(ctx, { title: "Outline", projectId: p.id });
    deleteProject(ctx, p.id);
    expect(ctx.store.get("task", t.id)!.projectId).toBeNull();
  });

  it("expands recurring events and finds free time around them", () => {
    const ctx = dbCtx(memoryDb(), clock);
    createEvent(ctx, { title: "Class", date: "2026-10-26", start: "09:00", end: "12:00", recurrence: { freq: "weekly", interval: 1, exDates: [] } });
    expect(eventsBetween(ctx, "2026-10-26", "2026-11-09").map((e) => e.occurrenceDate)).toEqual(["2026-10-26", "2026-11-02", "2026-11-09"]);
    const free = findFreeTime(ctx, "2026-10-26", "2026-10-26", 90);
    expect(free.every((b) => b.end <= "09:00" || b.start >= "12:00")).toBe(true);
    expect(free.some((b) => b.minutes >= 90)).toBe(true);
  });

  it("plans a day and writes times into tasks, leaving pinned and done tasks alone", () => {
    const ctx = dbCtx(memoryDb(), clock);
    createEvent(ctx, { title: "Class", date: "2026-10-26", start: "09:00", end: "12:00" });
    const pinned = createTask(ctx, { title: "Call", scheduledStart: "2026-10-26T13:00", estimateMin: 30 });
    const done = createTask(ctx, { title: "Done", plannedDate: "2026-10-26", status: "done" });
    const a = createTask(ctx, { title: "Study", plannedDate: "2026-10-26", estimateMin: 120, energy: "high" });
    applyPlan(ctx, computePlan(ctx, "2026-10-26", { mode: "full" }));
    expect(ctx.store.get("task", a.id)!.scheduledStart).not.toBeNull();
    expect(ctx.store.get("task", pinned.id)!.scheduledStart).toBe("2026-10-26T13:00");
    expect(ctx.store.get("task", done.id)!.scheduledStart).toBeNull();
    const view = dayView(ctx, "2026-10-26");
    expect(view.analysis.conflicts).toEqual([]);
    expect(view.progress).toMatchObject({ total: 3, done: 1 });
  });

  it("spreads backlog tasks across days before their deadlines", () => {
    const ctx = dbCtx(memoryDb(testSettings({ dayStart: "09:00", dayEnd: "12:00" })), clock, testSettings({ dayStart: "09:00", dayEnd: "12:00" }));
    const t1 = createTask(ctx, { title: "Big 1", estimateMin: 150, dueAt: "2026-10-27T23:59" });
    const t2 = createTask(ctx, { title: "Big 2", estimateMin: 150 });
    const r = distributeTasks(ctx, "2026-10-26", "2026-10-28");
    const d1 = r.assigned.find((a) => a.taskId === t1.id)!.date;
    const d2 = r.assigned.find((a) => a.taskId === t2.id)!.date;
    expect(d1 <= "2026-10-27").toBe(true);
    expect(d1).not.toBe(d2);
  });
});

describe("history and undo", () => {
  it("undoes a recorded mutation and refuses when the data changed since", () => {
    const db = memoryDb();
    const settings = testSettings();
    const now = () => clock().toISOString();
    const { result: task, history } = mutate(db, "create", "user", (store) => createTask({ store, settings, clock }, { title: "Undo me" }), now);
    expect(history).not.toBeNull();
    undoHistory(db, history!.id, now());
    expect(new DbStore(db).get("task", task.id)).toBeNull();

    const second = mutate(db, "create", "user", (store) => createTask({ store, settings, clock }, { title: "Keep" }), now);
    const edit = mutate(db, "edit", "user", (store) => updateTask({ store, settings, clock }, second.result.id, { title: "Edited" }), now);
    expect(edit.history).not.toBeNull();
    // A later edit makes undoing the creation unsafe: it must be refused, not silently applied.
    expect(() => undoHistory(db, second.history!.id, now())).toThrow(/changed since/);
    expect(new DbStore(db).get("task", second.result.id)!.title).toBe("Edited");
  });
});
