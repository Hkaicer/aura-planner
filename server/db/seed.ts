// Synthetic example data for the first-run experience. Every record is flagged
// `isDemo` so it can be removed in one step from onboarding or Settings.

import type { Settings } from "../../shared/schemas";
import { addDays, combine, isoWeekday, zonedNow, zonedToInstant } from "../../shared/time";
import type { DomainContext } from "../domain/context";
import { createEvent, createProject } from "../domain/entities";
import { applyPlan, computePlan, dayWindow } from "../domain/planning";
import { completeTask, createTask, isOpen, tasksForDate } from "../domain/tasks";
import type { Store } from "./store";

export function seedDemo(store: Store, settings: Settings, now: Date = new Date()) {
  const tz = settings.timeZone;
  const today = zonedNow(tz, now).date;
  const tomorrow = addDays(today, 1);
  const ctx: DomainContext = { store, settings, clock: () => now };
  const weekend = isoWeekday(today) >= 6;

  const lab = createProject(ctx, { name: "Cybersecurity lab report", description: "Network forensics lab, group of three.", deadline: addDays(today, 3), isDemo: true });
  const sc200 = createProject(ctx, { name: "SC-200 certification", description: "Microsoft Security Operations Analyst exam.", deadline: addDays(today, 24), isDemo: true });
  const jobs = createProject(ctx, { name: "Internship search", description: "Summer internship in security operations or pentesting.", isDemo: true });

  createEvent(ctx, {
    title: weekend ? "Study group at the library" : "Network security class",
    date: today,
    start: "14:00",
    end: weekend ? "16:00" : "17:00",
    kind: "commitment",
    location: weekend ? "Library, room 2" : "Building B, room 104",
    isDemo: true,
    source: "demo",
  });
  createEvent(ctx, { title: "Network security class", date: tomorrow, start: "09:00", end: "12:00", kind: "commitment", location: "Building B, room 104", isDemo: true, source: "demo" });

  const kql = createTask(ctx, {
    title: "Review KQL basics for SC-200",
    description: "Module 3: where, summarize, join. Do the two sandbox exercises.",
    priority: "high",
    estimateMin: 45,
    energy: "high",
    plannedDate: today,
    projectId: sc200.id,
    tags: ["study"],
    source: "demo",
    isDemo: true,
  });
  const method = createTask(ctx, {
    title: "Write lab report: methodology",
    description: "Capture setup, tooling (Wireshark, Zeek) and the attack timeline.",
    priority: "critical",
    estimateMin: 90,
    energy: "high",
    plannedDate: today,
    dueAt: combine(addDays(today, 2), "18:00"),
    projectId: lab.id,
    tags: ["writing"],
    source: "demo",
    isDemo: true,
  });
  createTask(ctx, {
    title: "Apply to three internships",
    priority: "high",
    estimateMin: 75,
    plannedDate: today,
    projectId: jobs.id,
    subtasks: ["SOC analyst internship", "Pentest internship", "GRC consulting internship"],
    source: "demo",
    isDemo: true,
  });
  createTask(ctx, { title: "Buy groceries", priority: "low", estimateMin: 30, energy: "low", plannedDate: today, category: "Errands", source: "demo", isDemo: true });
  const window = dayWindow(settings, null, today);
  const callStart = Math.min(window.end - 30, 20 * 60 + 30);
  createTask(ctx, {
    title: "Call family",
    priority: "medium",
    estimateMin: 30,
    energy: "low",
    scheduledStart: combine(today, `${String(Math.floor(callStart / 60)).padStart(2, "0")}:${String(callStart % 60).padStart(2, "0")}`),
    pinned: true,
    category: "Personal",
    source: "demo",
    isDemo: true,
  });
  createTask(ctx, {
    title: "Gym session",
    priority: "medium",
    estimateMin: 60,
    energy: "medium",
    category: "Health",
    recurrence: { freq: "weekly", interval: 1, byWeekday: [1, 3, 5], time: "18:30", exDates: [] },
    plannedDate: today,
    source: "demo",
    isDemo: true,
  });
  createTask(ctx, {
    title: "Weekly review",
    description: "Look back at the week, clear the inbox, plan the next one.",
    priority: "medium",
    estimateMin: 30,
    energy: "low",
    recurrence: { freq: "weekly", interval: 1, byWeekday: [7], time: "18:00", exDates: [] },
    plannedDate: today,
    source: "demo",
    isDemo: true,
  });

  createTask(ctx, {
    title: "Write lab report: results and conclusion",
    priority: "high",
    estimateMin: 60,
    energy: "high",
    plannedDate: tomorrow,
    dueAt: combine(addDays(today, 2), "18:00"),
    projectId: lab.id,
    dependsOn: [method.id],
    source: "demo",
    isDemo: true,
  });
  createTask(ctx, {
    title: "SC-200 practice exam (modules 1-3)",
    priority: "high",
    estimateMin: 120,
    energy: "high",
    plannedDate: tomorrow,
    projectId: sc200.id,
    source: "demo",
    isDemo: true,
  });
  createTask(ctx, { title: "Read NIST SP 800-61 on incident handling", priority: "medium", estimateMin: 60, tags: ["reading"], source: "demo", isDemo: true });
  createTask(ctx, {
    title: "Set up a Sentinel home lab",
    priority: "medium",
    estimateMin: 120,
    projectId: sc200.id,
    dependsOn: [kql.id],
    source: "demo",
    isDemo: true,
  });
  createTask(ctx, { title: "Blog post idea: detecting brute force with KQL", status: "inbox", priority: "low", source: "demo", isDemo: true });
  createTask(ctx, { title: "Check OSCP prerequisites", status: "inbox", priority: "low", source: "demo", isDemo: true });

  // Plan today as if it had been planned this morning, then mark what is
  // already behind us as done so the timeline shows a realistic day in progress.
  const morning = zonedToInstant(combine(today, settings.dayStart < "08:00" ? "08:00" : settings.dayStart), tz);
  const morningCtx: DomainContext = { ...ctx, clock: () => morning };
  applyPlan(morningCtx, computePlan(morningCtx, today, { mode: "full" }), { accept: true });
  const tomorrowPlan = computePlan(ctx, tomorrow, { mode: "full" });
  applyPlan(ctx, tomorrowPlan);

  const nowLocal = zonedNow(tz, now).dateTime;
  for (const t of tasksForDate(ctx, today)) {
    if (!isOpen(t) || !t.scheduledEnd || t.scheduledEnd > nowLocal || t.title === "Buy groceries") continue;
    const doneAt = zonedToInstant(t.scheduledEnd, tz);
    completeTask({ ...ctx, clock: () => doneAt }, t.id, { actualMin: t.estimateMin + (t.estimateMin >= 60 ? 15 : -5) });
  }
}
