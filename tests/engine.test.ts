import { describe, expect, it } from "vitest";
import { analyzeDay, planDay, scoreTask, type PlanResult } from "../server/scheduling/engine";
import { engineConfig, etask, hm, planInput } from "./helpers";

function noOverlaps(result: PlanResult, blocks: { start: number; end: number }[] = []) {
  const all = [
    ...result.placements.map((p) => ({ s: p.start, e: p.end, id: p.taskId })),
    ...blocks.map((b, i) => ({ s: b.start, e: b.end, id: `block${i}` })),
    ...(result.lunch ? [{ s: result.lunch.start, e: result.lunch.end, id: "lunch" }] : []),
    ...result.breaks.map((b, i) => ({ s: b.start, e: b.end, id: `break${i}` })),
  ].sort((a, b) => a.s - b.s);
  for (let i = 1; i < all.length; i++) {
    expect(all[i]!.s, `${all[i]!.id} overlaps ${all[i - 1]!.id}`).toBeGreaterThanOrEqual(all[i - 1]!.e);
  }
}

describe("scheduling engine", () => {
  it("never overlaps fixed commitments and keeps a buffer around them", () => {
    const blocks = [{ id: "class", title: "Class", start: hm("09:00"), end: hm("12:00"), kind: "commitment" as const }];
    const r = planDay(planInput({ blocks, tasks: [etask({ estimateMin: 60 }), etask({ estimateMin: 120 }), etask({ estimateMin: 30 })] }));
    expect(r.overflow).toHaveLength(0);
    noOverlaps(r, blocks);
    for (const p of r.placements) {
      const clear = p.end <= hm("09:00") - 5 || p.start >= hm("12:00") + 5;
      expect(clear, `${p.title} respects the class buffer`).toBe(true);
    }
  });

  it("schedules a task with a hard deadline before the deadline", () => {
    const due = etask({ title: "Due at 11", estimateMin: 60, dueAt: "2026-10-26T11:00", priority: "low" });
    const r = planDay(planInput({ tasks: [etask({ estimateMin: 120, priority: "high" }), due] }));
    const p = r.placements.find((x) => x.taskId === due.id)!;
    expect(p.end).toBeLessThanOrEqual(hm("11:00"));
  });

  it("reports a hard deadline that cannot be met instead of ignoring it", () => {
    const blocks = [{ id: "c", title: "Busy", start: hm("08:00"), end: hm("10:30"), kind: "commitment" as const }];
    const t = etask({ title: "Report", estimateMin: 60, dueAt: "2026-10-26T11:00" });
    const r = planDay(planInput({ blocks, tasks: [t] }));
    expect(r.placements).toHaveLength(0);
    expect(r.overflow[0]).toMatchObject({ taskId: t.id, reason: "deadline" });
    expect(r.stats.status).toBe("overloaded");
  });

  it("flags an overloaded day and leaves out the lowest-scoring work", () => {
    const tasks = [
      etask({ title: "Critical", priority: "critical", estimateMin: 240 }),
      etask({ title: "High", priority: "high", estimateMin: 240 }),
      etask({ title: "Low", priority: "low", estimateMin: 240 }),
      etask({ title: "Medium", priority: "medium", estimateMin: 240 }),
    ];
    const r = planDay(planInput({ window: { start: hm("08:00"), end: hm("20:00") }, tasks }));
    expect(r.stats.status).toBe("overloaded");
    expect(r.overflow.map((o) => o.title)).toContain("Low");
    expect(r.placements.map((p) => p.title)).toContain("Critical");
    expect(r.explanation.join(" ")).toMatch(/do not fit/);
    noOverlaps(r);
  });

  it("orders dependent tasks and blocks those whose prerequisite cannot run", () => {
    const a = etask({ title: "A", estimateMin: 60, priority: "low" });
    const b = etask({ title: "B", estimateMin: 60, priority: "critical", dependsOn: [a.id] });
    const r = planDay(planInput({ tasks: [b, a] }));
    const pa = r.placements.find((p) => p.taskId === a.id)!;
    const pb = r.placements.find((p) => p.taskId === b.id)!;
    expect(pb.start).toBeGreaterThanOrEqual(pa.end);

    const blocked = planDay(
      planInput({
        tasks: [etask({ id: "x", title: "Needs Y", dependsOn: ["y"] })],
        dependencies: { y: { status: "todo", plannedDate: "2026-10-28", scheduledEnd: null, title: "Y" } },
      }),
    );
    expect(blocked.overflow[0]).toMatchObject({ taskId: "x", reason: "blocked" });
  });

  it("does not move pinned or completed tasks", () => {
    const pinned = etask({ title: "Pinned", pinned: true, scheduledStart: "2026-10-26T10:00", scheduledEnd: "2026-10-26T11:00" });
    const done = etask({ title: "Done", status: "done", scheduledStart: "2026-10-26T08:00", scheduledEnd: "2026-10-26T09:00" });
    const r = planDay(planInput({ tasks: [pinned, done, etask({ estimateMin: 120 })] }));
    expect(r.placements.find((p) => p.taskId === pinned.id)).toBeUndefined();
    expect(r.placements.find((p) => p.taskId === done.id)).toBeUndefined();
    for (const p of r.placements) expect(p.end <= hm("10:00") - 5 || p.start >= hm("11:00") + 5).toBe(true);
  });

  it("inserts a break after a long focus streak", () => {
    const r = planDay(planInput({ tasks: [etask({ estimateMin: 90 }), etask({ estimateMin: 60 })], config: engineConfig({ focusBlockMin: 90, breakMin: 15 }) }));
    expect(r.breaks.length).toBeGreaterThanOrEqual(1);
    const [first, second] = [...r.placements].sort((a, b) => a.start - b.start);
    expect(second!.start - first!.end).toBeGreaterThanOrEqual(15);
  });

  it("reserves lunch inside the configured window", () => {
    const r = planDay(
      planInput({
        tasks: [etask({ estimateMin: 240 }), etask({ estimateMin: 120 })],
        config: engineConfig({ lunch: { enabled: true, earliest: hm("12:00"), latest: hm("14:00"), durationMin: 45 } }),
      }),
    );
    expect(r.lunch).not.toBeNull();
    expect(r.lunch!.start).toBeGreaterThanOrEqual(hm("12:00"));
    expect(r.lunch!.end).toBeLessThanOrEqual(hm("14:00"));
    noOverlaps(r);
  });

  it("puts demanding work in the peak-energy window when possible", () => {
    const blocks = [{ id: "c", title: "Class", start: hm("14:00"), end: hm("15:00"), kind: "commitment" as const }];
    const deep = etask({ title: "Deep", energy: "high", priority: "low", estimateMin: 60 });
    const r = planDay(planInput({ blocks, tasks: [etask({ title: "Errand", priority: "high", estimateMin: 120 }), deep] }));
    const p = r.placements.find((x) => x.taskId === deep.id)!;
    expect(p.end).toBeLessThanOrEqual(hm("12:00"));
    expect(p.reasons).toContain("peak_energy");
  });

  it("keeps still-valid placements in preserve mode", () => {
    const a = etask({ title: "Kept", scheduledStart: "2026-10-26T15:00", scheduledEnd: "2026-10-26T16:00" });
    const r = planDay(planInput({ mode: "preserve", tasks: [a, etask({ title: "New", estimateMin: 30 })] }));
    const p = r.placements.find((x) => x.taskId === a.id)!;
    expect(p.start).toBe(hm("15:00"));
    expect(p.moved).toBe(false);
  });

  it("reflows the rest of the day after a delay, after now, in the previous order", () => {
    // It is 11:30 on the day; the 10:00 task was missed.
    const missed = etask({ title: "Missed", scheduledStart: "2026-10-26T10:00", scheduledEnd: "2026-10-26T11:00" });
    const later = etask({ title: "Later", scheduledStart: "2026-10-26T13:00", scheduledEnd: "2026-10-26T14:00" });
    const r = planDay(planInput({ mode: "reflow", now: { date: "2026-10-26", minutes: hm("11:30") }, tasks: [later, missed] }));
    const pm = r.placements.find((p) => p.taskId === missed.id)!;
    const pl = r.placements.find((p) => p.taskId === later.id)!;
    expect(pm.start).toBeGreaterThanOrEqual(hm("11:30"));
    expect(pl.start).toBeGreaterThan(pm.start);
  });

  it("explains what must be postponed when a delay makes the day overflow", () => {
    const tasks = [
      etask({ title: "Study", priority: "high", estimateMin: 120, scheduledStart: "2026-10-26T17:00", scheduledEnd: "2026-10-26T19:00" }),
      etask({ title: "Groceries", priority: "low", estimateMin: 30, scheduledStart: "2026-10-26T19:05", scheduledEnd: "2026-10-26T19:35" }),
    ];
    const r = planDay(planInput({ mode: "reflow", window: { start: hm("08:00"), end: hm("20:00") }, now: { date: "2026-10-26", minutes: hm("17:50") }, tasks }));
    expect(r.overflow.map((o) => o.title)).toEqual(["Groceries"]);
    expect(r.placements.map((p) => p.title)).toEqual(["Study"]);
    expect(r.stats.status).toBe("overloaded");
  });

  it("makes a light day lighter", () => {
    const r = planDay(
      planInput({
        config: engineConfig({ intensity: "light" }),
        tasks: [etask({ title: "Low", priority: "low", estimateMin: 30 }), etask({ title: "High", priority: "high", estimateMin: 60 })],
      }),
    );
    expect(r.overflow.find((o) => o.title === "Low")?.reason).toBe("light_day");
    expect(r.stats.status).not.toBe("overloaded");
  });

  it("schedules nothing on a past day", () => {
    const r = planDay(planInput({ date: "2026-10-20", tasks: [etask()] }));
    expect(r.placements).toHaveLength(0);
    expect(r.stats.status).toBe("past");
  });

  it("exposes a transparent score breakdown", () => {
    const s = scoreTask({ priority: "high", dueAt: "2026-10-26T10:00", dueHard: true, postponedCount: 2, projectDeadline: null }, "2026-10-26T08:00");
    expect(s.parts.map((p) => p.key)).toEqual(["priority", "deadline", "postponed"]);
    expect(s.total).toBe(70 + 60 + 12);
  });

  it("acceptance A: class 09:00-12:00, four tasks, lunch, finish by 20:00", () => {
    const blocks = [{ id: "class", title: "Class", start: hm("09:00"), end: hm("12:00"), kind: "commitment" as const }];
    const tasks = [
      etask({ title: "Study", estimateMin: 120, energy: "high" }),
      etask({ title: "Project work", estimateMin: 90, energy: "high" }),
      etask({ title: "Exercise", estimateMin: 60 }),
      etask({ title: "Groceries", estimateMin: 30, energy: "low" }),
    ];
    const r = planDay(
      planInput({
        window: { start: hm("08:00"), end: hm("20:00") },
        blocks,
        tasks,
        config: engineConfig({ lunch: { enabled: true, earliest: hm("12:00"), latest: hm("14:00"), durationMin: 45 } }),
      }),
    );
    expect(r.overflow).toHaveLength(0);
    expect(r.lunch).not.toBeNull();
    noOverlaps(r, blocks);
    for (const p of r.placements) expect(p.end).toBeLessThanOrEqual(hm("20:00"));
  });

  it("analyzes an existing schedule for overlaps and missed work", () => {
    const a = analyzeDay({
      date: "2026-10-26",
      now: { date: "2026-10-26", minutes: hm("12:00") },
      window: { start: hm("08:00"), end: hm("22:00") },
      blocks: [{ id: "c", title: "Class", start: hm("14:00"), end: hm("16:00"), kind: "commitment" }],
      tasks: [
        etask({ id: "m", title: "Missed", scheduledStart: "2026-10-26T09:00", scheduledEnd: "2026-10-26T10:00" }),
        etask({ id: "o", title: "Overlap", scheduledStart: "2026-10-26T15:00", scheduledEnd: "2026-10-26T15:30" }),
      ],
      dependencies: {},
      config: engineConfig(),
    });
    expect(a.conflicts.map((c) => c.kind).sort()).toEqual(["missed", "overlap"]);
  });
});
