import type { QueryClient } from "@tanstack/react-query";
import type { DayView, RangeDay } from "@shared/api";
import type { Task } from "@shared/schemas";
import { dateOf, type ZonedNow } from "@shared/time";

export interface TaskState {
  done: boolean;
  overdue: boolean;
  missed: boolean;
  now: boolean;
  inProgress: boolean;
  blocked: boolean;
  later: boolean;
}

export function taskState(t: Task, now: ZonedNow, statusById?: Map<string, Task["status"]>): TaskState {
  const done = t.status === "done" || t.status === "cancelled";
  const overdue = !done && t.dueAt !== null && t.dueAt < now.dateTime;
  const missed =
    !done &&
    ((t.scheduledEnd !== null && t.scheduledEnd <= now.dateTime) || (t.plannedDate !== null && t.plannedDate < now.date));
  const happening = !done && t.scheduledStart !== null && t.scheduledStart <= now.dateTime && (t.scheduledEnd ?? "") > now.dateTime;
  const blocked = !done && t.dependsOn.some((d) => {
    const s = statusById?.get(d);
    return s !== undefined && s !== "done" && s !== "cancelled";
  });
  const later = !done && t.scheduledStart !== null && t.scheduledStart > now.dateTime;
  return { done, overdue, missed: missed && !happening, now: happening, inProgress: t.status === "in_progress", blocked, later };
}

/** Apply a local patch to a task in every cached list so the UI responds instantly. */
export function patchTaskInCaches(qc: QueryClient, id: string, patch: Partial<Task>) {
  const apply = (t: Task) => (t.id === id ? { ...t, ...patch } : t);
  qc.setQueriesData<DayView>({ queryKey: ["day"] }, (d) =>
    d ? { ...d, tasks: d.tasks.map(apply), overdue: d.overdue.map(apply), progress: recountProgress(d.tasks.map(apply)) } : d,
  );
  qc.setQueriesData<Task[]>({ queryKey: ["tasks"] }, (list) => (Array.isArray(list) ? list.map(apply) : list));
  qc.setQueriesData<RangeDay[]>({ queryKey: ["range"] }, (days) => (Array.isArray(days) ? days.map((d) => ({ ...d, tasks: d.tasks.map(apply) })) : days));
}

function recountProgress(tasks: Task[]): DayView["progress"] {
  const counted = tasks.filter((t) => t.status !== "cancelled");
  const done = counted.filter((t) => t.status === "done");
  return {
    total: counted.length,
    done: done.length,
    pct: counted.length ? Math.round((done.length / counted.length) * 100) : 0,
    plannedMin: counted.reduce((s, t) => s + t.estimateMin, 0),
    doneMin: done.reduce((s, t) => s + t.estimateMin, 0),
    actualMin: done.reduce((s, t) => s + (t.actualMin ?? 0), 0),
  };
}

export const PRIORITY_ORDER: Task["priority"][] = ["critical", "high", "medium", "low"];

export function isScheduledOn(t: Task, date: string) {
  return t.scheduledStart !== null && dateOf(t.scheduledStart) === date;
}
