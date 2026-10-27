// Deterministic scheduling engine.
//
// Pure functions only: no database, no clock, no AI. The engine receives a
// structured description of one day (window, fixed blocks, candidate tasks)
// and returns a placement that never overlaps fixed commitments, never ignores
// a hard deadline silently, and explains everything it could not fit.

import type { Energy, Intensity, PlanMode, Priority, TaskStatus } from "../../shared/schemas";
import { dateOf, diffMinutes, minutesOf } from "../../shared/time";

export interface EngineTask {
  id: string;
  title: string;
  estimateMin: number;
  priority: Priority;
  energy: Energy;
  status: TaskStatus;
  dueAt: string | null;
  dueHard: boolean;
  dependsOn: string[];
  pinned: boolean;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  plannedDate: string | null;
  postponedCount: number;
  projectDeadline: string | null;
  createdAt: string;
}

export type BlockKind = "commitment" | "break" | "unavailable" | "pinned" | "lunch" | "auto_break" | "task" | "hold";

export interface EngineBlock {
  id: string;
  title: string;
  start: number;
  end: number;
  kind: BlockKind;
}

export interface EngineConfig {
  bufferMin: number;
  focusBlockMin: number;
  breakMin: number;
  lunch: { enabled: boolean; earliest: number; latest: number; durationMin: number };
  peak: { start: number; end: number };
  strategy: "balanced" | "deadline_first" | "priority_first";
  intensity: Intensity;
}

/** State of a dependency that is not itself a candidate for this day. */
export interface DependencyInfo {
  status: TaskStatus;
  plannedDate: string | null;
  scheduledEnd: string | null;
  title: string;
}

export interface PlanInput {
  date: string;
  now: { date: string; minutes: number };
  window: { start: number; end: number };
  /** Fixed blocks: events, unavailable periods, user breaks. */
  blocks: EngineBlock[];
  /** Open tasks planned for this day (pinned ones are treated as fixed). */
  tasks: EngineTask[];
  dependencies: Record<string, DependencyInfo>;
  config: EngineConfig;
  mode: PlanMode;
  /** Reserve this many minutes starting now (e.g. "I'm unavailable for an hour"). */
  blockFromNowMin?: number;
}

export interface ScorePart {
  key: "priority" | "deadline" | "overdue" | "postponed" | "project_deadline";
  value: number;
  detail?: string;
}

export interface TaskScore {
  total: number;
  parts: ScorePart[];
}

export interface Placement {
  taskId: string;
  title: string;
  start: number;
  end: number;
  score: number;
  moved: boolean;
  previousStart: number | null;
  reasons: string[];
}

export type OverflowReason = "no_time" | "deadline" | "blocked" | "light_day";

export interface Overflow {
  taskId: string;
  title: string;
  reason: OverflowReason;
  detail: string;
  estimateMin: number;
  score: number;
}

export type DayStatus = "ok" | "tight" | "overloaded" | "past" | "empty";

export interface PlanStats {
  windowMin: number;
  availableMin: number;
  scheduledMin: number;
  breakMin: number;
  freeMin: number;
  demandMin: number;
  overloadMin: number;
  status: DayStatus;
}

export interface PlanResult {
  date: string;
  mode: PlanMode;
  effectiveStart: number;
  placements: Placement[];
  overflow: Overflow[];
  breaks: { start: number; end: number; label: string }[];
  lunch: { start: number; end: number } | null;
  stats: PlanStats;
  explanation: string[];
  warnings: string[];
}

const PRIORITY_POINTS: Record<Priority, number> = { critical: 100, high: 70, medium: 40, low: 15 };

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Transparent priority score. Every component is reported so the UI and the
 * assistant can explain why a task was placed where it was.
 */
export function scoreTask(
  task: Pick<EngineTask, "priority" | "dueAt" | "dueHard" | "postponedCount" | "projectDeadline">,
  reference: string,
  strategy: EngineConfig["strategy"] = "balanced",
): TaskScore {
  const parts: ScorePart[] = [];
  const priorityWeight = strategy === "priority_first" ? 1.4 : 1;
  const deadlineWeight = strategy === "deadline_first" ? 1.6 : strategy === "priority_first" ? 0.7 : 1;

  parts.push({ key: "priority", value: Math.round(PRIORITY_POINTS[task.priority] * priorityWeight), detail: task.priority });

  if (task.dueAt) {
    const hours = diffMinutes(reference, task.dueAt) / 60;
    let urgency = 0;
    let key: ScorePart["key"] = "deadline";
    if (hours < 0) {
      urgency = 90;
      key = "overdue";
    } else if (hours <= 24 || dateOf(task.dueAt) === dateOf(reference)) urgency = 60;
    else if (hours <= 48) urgency = 40;
    else if (hours <= 72) urgency = 25;
    else if (hours <= 168) urgency = 10;
    if (!task.dueHard) urgency *= 0.6;
    if (urgency > 0) parts.push({ key, value: Math.round(urgency * deadlineWeight), detail: task.dueAt });
  }

  if (task.postponedCount > 0) {
    parts.push({ key: "postponed", value: Math.min(task.postponedCount * 6, 24), detail: String(task.postponedCount) });
  }

  if (task.projectDeadline) {
    const days = diffMinutes(reference, `${task.projectDeadline}T23:59`) / 1440;
    if (days >= 0 && days <= 7) parts.push({ key: "project_deadline", value: 8, detail: task.projectDeadline });
  }

  return { total: parts.reduce((sum, p) => sum + p.value, 0), parts };
}

// ---------------------------------------------------------------------------
// Interval helpers
// ---------------------------------------------------------------------------

interface Busy {
  start: number;
  end: number;
  kind: BlockKind;
  id: string;
}

const isWorkKind = (k: BlockKind) => k === "task" || k === "pinned" || k === "commitment";
const needsBuffer = (k: BlockKind) => k === "task" || k === "pinned" || k === "commitment";

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function insertSorted(list: Busy[], item: Busy) {
  let i = 0;
  while (i < list.length && list[i]!.start <= item.start) i++;
  list.splice(i, 0, item);
}

function freeMinutes(busy: Busy[], from: number, to: number): number {
  if (to <= from) return 0;
  const clipped = busy
    .map((b) => ({ start: Math.max(b.start, from), end: Math.min(b.end, to) }))
    .filter((b) => b.end > b.start)
    .sort((a, b) => a.start - b.start);
  let used = 0;
  let cursor = from;
  for (const b of clipped) {
    if (b.end <= cursor) continue;
    used += b.end - Math.max(b.start, cursor);
    cursor = b.end;
  }
  return to - from - used;
}

interface SlotQuery {
  duration: number;
  minStart: number;
  maxEnd: number;
}

class Timeline {
  readonly busy: Busy[] = [];
  readonly autoBreaks: { start: number; end: number }[] = [];

  constructor(
    private readonly cfg: EngineConfig,
    readonly windowEnd: number,
  ) {}

  add(item: Busy) {
    insertSorted(this.busy, item);
  }

  /** True when [s, e) collides with a busy block, including required buffers. */
  collides(s: number, e: number): boolean {
    for (const b of this.busy) {
      const pad = needsBuffer(b.kind) ? this.cfg.bufferMin : 0;
      if (overlaps(s, e, b.start - pad, b.end + pad)) return true;
    }
    return false;
  }

  /** True when [s, e) overlaps a busy block, ignoring buffers. */
  overlapsAny(s: number, e: number): boolean {
    return this.busy.some((b) => overlaps(s, e, b.start, b.end));
  }

  /** Continuous work immediately before `s` (tasks and commitments without a real break). */
  private chainBefore(s: number): { work: number; end: number } {
    const rest = Math.max(this.cfg.breakMin, 1);
    let cursor = s;
    let work = 0;
    let chainEnd = -1;
    const before = this.busy.filter((b) => b.end <= s).sort((a, b) => b.end - a.end);
    for (const b of before) {
      if (cursor - b.end >= rest) break;
      if (!isWorkKind(b.kind)) break;
      if (chainEnd < 0) chainEnd = b.end;
      work += b.end - b.start;
      cursor = b.start;
    }
    return { work, end: chainEnd };
  }

  find(q: SlotQuery): { start: number; breakBefore: { start: number; end: number } | null } | null {
    if (q.maxEnd - q.minStart < q.duration) return null;
    const candidates = new Set<number>([q.minStart]);
    for (const b of this.busy) {
      const pad = needsBuffer(b.kind) ? this.cfg.bufferMin : 0;
      const c = b.end + pad;
      if (c >= q.minStart && c < q.maxEnd) candidates.add(c);
    }
    const sorted = [...candidates].sort((a, b) => a - b);
    for (const c of sorted) {
      let start = c;
      let brk: { start: number; end: number } | null = null;
      if (this.cfg.breakMin > 0) {
        const chain = this.chainBefore(start);
        if (chain.work > 0 && chain.work + q.duration > this.cfg.focusBlockMin) {
          const breakStart = chain.end;
          const breakEnd = chain.end + this.cfg.breakMin;
          start = Math.max(start, breakEnd);
          brk = { start: breakStart, end: breakEnd };
          if (this.collides(breakStart, breakEnd) && !this.onlyTouches(breakStart, breakEnd)) brk = null;
        }
      }
      const end = start + q.duration;
      if (end > q.maxEnd || end > this.windowEnd) continue;
      if (this.collides(start, end)) continue;
      return { start, breakBefore: brk };
    }
    return null;
  }

  /** A break may touch the block it follows (buffer padding) without truly overlapping it. */
  private onlyTouches(s: number, e: number): boolean {
    return !this.busy.some((b) => overlaps(s, e, b.start, b.end));
  }

  addBreak(brk: { start: number; end: number }) {
    if (this.autoBreaks.some((b) => overlaps(b.start, b.end, brk.start, brk.end))) return;
    this.autoBreaks.push(brk);
    this.add({ start: brk.start, end: brk.end, kind: "auto_break", id: `break-${brk.start}` });
  }
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

function ceilTo(value: number, step: number) {
  return Math.ceil(value / step) * step;
}

export function effectiveStartFor(date: string, now: PlanInput["now"], window: PlanInput["window"]): number {
  if (date < now.date) return window.end;
  if (date > now.date) return window.start;
  return Math.min(window.end, Math.max(window.start, ceilTo(now.minutes, 5)));
}

function placementOnDate(task: EngineTask, date: string): { start: number; end: number } | null {
  if (!task.scheduledStart || dateOf(task.scheduledStart) !== date) return null;
  const start = minutesOf(task.scheduledStart);
  const end = task.scheduledEnd && dateOf(task.scheduledEnd) === date ? minutesOf(task.scheduledEnd) : start + task.estimateMin;
  return { start, end: Math.max(end, start + 5) };
}

function hardDueMinute(task: EngineTask, date: string): number | null {
  if (!task.dueAt || !task.dueHard) return null;
  const dueDate = dateOf(task.dueAt);
  if (dueDate === date) return minutesOf(task.dueAt);
  return null;
}

interface Scored {
  task: EngineTask;
  score: TaskScore;
  prev: { start: number; end: number } | null;
}

interface RunState {
  timeline: Timeline;
  placements: Placement[];
  overflow: Overflow[];
  placedEnd: Map<string, number>;
}

function newState(input: PlanInput, cfg: EngineConfig, baseBusy: Busy[]): RunState {
  const timeline = new Timeline(cfg, input.window.end);
  for (const b of baseBusy) timeline.add({ ...b });
  return { timeline, placements: [], overflow: [], placedEnd: new Map() };
}

function dependencyGate(
  item: Scored,
  state: RunState,
  input: PlanInput,
  pendingIds: Set<string>,
): { ok: true; minStart: number; warning?: string } | { ok: false; waitFor: string; blocked: boolean } {
  let minStart = 0;
  let warning: string | undefined;
  for (const depId of item.task.dependsOn) {
    const placed = state.placedEnd.get(depId);
    if (placed !== undefined) {
      minStart = Math.max(minStart, placed);
      continue;
    }
    if (pendingIds.has(depId)) return { ok: false, waitFor: depId, blocked: false };
    const info = input.dependencies[depId];
    if (!info) continue; // dependency was deleted: no longer blocks
    if (info.status === "done" || info.status === "cancelled") continue;
    if (info.plannedDate && info.plannedDate < input.date) {
      warning = `"${item.task.title}" depends on "${info.title}", which is still open from ${info.plannedDate}.`;
      continue;
    }
    if (info.scheduledEnd && dateOf(info.scheduledEnd) === input.date) {
      minStart = Math.max(minStart, minutesOf(info.scheduledEnd));
      continue;
    }
    return { ok: false, waitFor: info.title, blocked: true };
  }
  return warning ? { ok: true, minStart, warning } : { ok: true, minStart };
}

function preferredWindow(task: EngineTask, cfg: EngineConfig): { start: number; end: number } | null {
  if (task.energy !== "high") return null;
  return cfg.peak;
}

/** List scheduling: repeatedly place the first ready task in `order`. */
function placeSequence(order: Scored[], state: RunState, input: PlanInput, effectiveStart: number, warnings: string[]) {
  const pending = [...order];
  const pendingIds = new Set(pending.map((p) => p.task.id));
  while (pending.length > 0) {
    let pickedIndex = -1;
    let gate: ReturnType<typeof dependencyGate> | null = null;
    for (let i = 0; i < pending.length; i++) {
      const g = dependencyGate(pending[i]!, state, input, pendingIds);
      if (g.ok) {
        pickedIndex = i;
        gate = g;
        break;
      }
      if (g.blocked) {
        const item = pending[i]!;
        state.overflow.push({
          taskId: item.task.id,
          title: item.task.title,
          reason: "blocked",
          detail: `Waiting for "${g.waitFor}" to be done first.`,
          estimateMin: item.task.estimateMin,
          score: item.score.total,
        });
        pending.splice(i, 1);
        pendingIds.delete(item.task.id);
        i--;
      }
    }
    if (pickedIndex < 0 || !gate || !gate.ok) {
      // Remaining tasks wait on each other (cycle) or on tasks that did not fit.
      for (const item of pending) {
        state.overflow.push({
          taskId: item.task.id,
          title: item.task.title,
          reason: "blocked",
          detail: "Its dependencies could not be scheduled today.",
          estimateMin: item.task.estimateMin,
          score: item.score.total,
        });
      }
      break;
    }
    const item = pending.splice(pickedIndex, 1)[0]!;
    pendingIds.delete(item.task.id);
    if (gate.warning) warnings.push(gate.warning);

    const cfg = input.config;
    const due = hardDueMinute(item.task, input.date);
    const minStart = Math.max(effectiveStart, gate.minStart > 0 ? gate.minStart + cfg.bufferMin : 0);
    const maxEnd = due !== null ? Math.min(due, input.window.end) : input.window.end;
    const duration = item.task.estimateMin;

    let slot: ReturnType<Timeline["find"]> = null;
    const pref = preferredWindow(item.task, cfg);
    if (pref) {
      slot = state.timeline.find({
        duration,
        minStart: Math.max(minStart, pref.start),
        maxEnd: Math.min(maxEnd, pref.end),
      });
    }
    if (!slot) slot = state.timeline.find({ duration, minStart, maxEnd });

    if (!slot) {
      const fitsWithoutDeadline =
        due !== null && state.timeline.find({ duration, minStart, maxEnd: input.window.end }) !== null;
      state.overflow.push({
        taskId: item.task.id,
        title: item.task.title,
        reason: due !== null ? "deadline" : "no_time",
        detail:
          due !== null
            ? fitsWithoutDeadline
              ? `Only fits after its hard deadline (${item.task.dueAt?.slice(11)}).`
              : `Cannot be completed before its hard deadline (${item.task.dueAt?.slice(11)}).`
            : `Needs ${duration} min; no free block that long remains.`,
        estimateMin: duration,
        score: item.score.total,
      });
      continue;
    }

    if (slot.breakBefore) state.timeline.addBreak(slot.breakBefore);
    const start = slot.start;
    const end = start + duration;
    state.timeline.add({ start, end, kind: "task", id: item.task.id });
    state.placedEnd.set(item.task.id, end);

    const reasons: string[] = [];
    const top = [...item.score.parts].sort((a, b) => b.value - a.value)[0];
    if (top) reasons.push(top.key);
    if (pref && start >= pref.start && end <= pref.end) reasons.push("peak_energy");
    if (item.task.dependsOn.length > 0) reasons.push("after_dependencies");
    if (due !== null) reasons.push("before_deadline");

    state.placements.push({
      taskId: item.task.id,
      title: item.task.title,
      start,
      end,
      score: item.score.total,
      moved: item.prev ? item.prev.start !== start : true,
      previousStart: item.prev?.start ?? null,
      reasons,
    });
  }
}

function overflowWeight(overflow: Overflow[]): number {
  return overflow.reduce((sum, o) => sum + o.score * 1000 + o.estimateMin, 0);
}

export function planDay(input: PlanInput): PlanResult {
  const baseCfg = input.config;
  const light = baseCfg.intensity === "light";
  const cfg: EngineConfig = light
    ? { ...baseCfg, focusBlockMin: Math.min(baseCfg.focusBlockMin, 60), breakMin: Math.max(baseCfg.breakMin, 15) }
    : baseCfg;
  const warnings: string[] = [];
  const explanation: string[] = [];
  const effectiveStart = effectiveStartFor(input.date, input.now, input.window);
  const reference = input.date === input.now.date ? `${input.date}T${fmt(input.now.minutes)}` : `${input.date}T00:00`;

  // Fixed blocks: events, unavailable periods, user-created breaks, pinned tasks.
  const baseBusy: Busy[] = input.blocks.map((b) => ({ start: b.start, end: b.end, kind: b.kind, id: b.id }));
  const open = input.tasks.filter((t) => t.status !== "done" && t.status !== "cancelled");
  for (const t of open) {
    if (!t.pinned) continue;
    const p = placementOnDate(t, input.date);
    if (p) baseBusy.push({ start: p.start, end: p.end, kind: "pinned", id: t.id });
  }
  if (input.blockFromNowMin && input.blockFromNowMin > 0 && input.date === input.now.date) {
    baseBusy.push({ start: effectiveStart, end: effectiveStart + input.blockFromNowMin, kind: "hold", id: "hold" });
    explanation.push(`Reserved ${input.blockFromNowMin} min from now as unavailable.`);
  }

  // Lunch is reserved before tasks so it never gets squeezed out.
  let lunch: PlanResult["lunch"] = null;
  const lunchCfg = cfg.lunch;
  const hasUserBreak = input.blocks.some(
    (b) => b.kind === "break" && overlaps(b.start, b.end, lunchCfg.earliest, lunchCfg.latest),
  );
  if (lunchCfg.enabled && !hasUserBreak && input.date >= input.now.date) {
    const lunchTimeline = new Timeline({ ...cfg, bufferMin: 0, breakMin: 0 }, input.window.end);
    for (const b of baseBusy) lunchTimeline.add({ ...b });
    const slot = lunchTimeline.find({
      duration: lunchCfg.durationMin,
      minStart: Math.max(lunchCfg.earliest, effectiveStart),
      maxEnd: lunchCfg.latest,
    });
    if (slot) {
      lunch = { start: slot.start, end: slot.start + lunchCfg.durationMin };
      baseBusy.push({ start: lunch.start, end: lunch.end, kind: "lunch", id: "lunch" });
    }
  }

  const candidates: Scored[] = open
    .filter((t) => !t.pinned || !placementOnDate(t, input.date))
    .map((task) => ({ task, score: scoreTask(task, reference, cfg.strategy), prev: placementOnDate(task, input.date) }));

  const byScore = (a: Scored, b: Scored) =>
    b.score.total - a.score.total ||
    (a.task.dueAt ?? "9999").localeCompare(b.task.dueAt ?? "9999") ||
    a.task.createdAt.localeCompare(b.task.createdAt);

  let lightDrops: Overflow[] = [];
  let pool = candidates;
  if (light) {
    const keep: Scored[] = [];
    for (const c of [...candidates].sort(byScore)) {
      const dueSoon = c.task.dueAt ? diffMinutes(reference, c.task.dueAt) <= 48 * 60 : false;
      if (c.task.priority === "low" && !dueSoon) {
        lightDrops.push({
          taskId: c.task.id,
          title: c.task.title,
          reason: "light_day",
          detail: "Low priority and not urgent: left out of a lighter day.",
          estimateMin: c.task.estimateMin,
          score: c.score.total,
        });
      } else keep.push(c);
    }
    pool = keep;
    explanation.push("Light day: low-priority tasks without a near deadline are left out, blocks capped at 60 min.");
  }

  if (input.date < input.now.date) {
    return finalize(input, cfg, effectiveStart, baseBusy, [], candidates.map((c) => toOverflow(c, "no_time", "This day is in the past.")), [], lunch, warnings, ["This day is in the past; nothing can be scheduled."]);
  }

  const run = (order: Scored[], keepExisting: boolean): RunState => {
    const state = newState(input, cfg, baseBusy);
    let rest = order;
    if (keepExisting) {
      // Keep still-valid placements in place, then fill the gaps.
      const kept: Scored[] = [];
      rest = [];
      for (const c of [...order].sort((a, b) => (a.prev?.start ?? 1e9) - (b.prev?.start ?? 1e9))) {
        if (!c.prev) {
          rest.push(c);
          continue;
        }
        const due = hardDueMinute(c.task, input.date);
        const start = c.prev.start;
        const end = start + c.task.estimateMin;
        const valid =
          start >= effectiveStart &&
          end <= input.window.end &&
          (due === null || end <= due) &&
          !state.timeline.overlapsAny(start, end) &&
          c.task.dependsOn.every((d) => {
            const info = input.dependencies[d];
            const placedEnd = state.placedEnd.get(d);
            if (placedEnd !== undefined) return placedEnd <= start;
            return !info || info.status === "done" || info.status === "cancelled" || (info.plannedDate ?? "") < input.date;
          });
        if (valid) {
          state.timeline.add({ start, end, kind: "task", id: c.task.id });
          state.placedEnd.set(c.task.id, end);
          state.placements.push({
            taskId: c.task.id,
            title: c.task.title,
            start,
            end,
            score: c.score.total,
            moved: end !== c.prev.end,
            previousStart: start,
            reasons: ["kept"],
          });
          kept.push(c);
        } else rest.push(c);
      }
      rest.sort(byScore);
    }
    placeSequence(rest, state, input, effectiveStart, warnings);
    return state;
  };

  let state: RunState;
  if (input.mode === "preserve") {
    state = run(pool, true);
    explanation.push("Kept tasks whose current time is still valid and placed the rest in the remaining gaps.");
  } else if (input.mode === "reflow") {
    // Decide what fits by priority, then keep the previous order among those tasks.
    const feasibility = run([...pool].sort(byScore), false);
    const fitting = new Set(feasibility.placements.map((p) => p.taskId));
    const ordered = [...pool].sort((a, b) => {
      const pa = a.prev?.start ?? null;
      const pb = b.prev?.start ?? null;
      if (pa !== null && pb !== null) return pa - pb;
      if (pa !== null) return -1;
      if (pb !== null) return 1;
      return byScore(a, b);
    });
    const attempt = run(
      ordered.filter((c) => fitting.has(c.task.id)),
      false,
    );
    if (attempt.overflow.length === 0) {
      attempt.overflow.push(...feasibility.overflow);
      state = attempt;
      explanation.push("Shifted the remaining tasks forward from now, keeping their previous order.");
    } else {
      state = feasibility;
      explanation.push("Rebuilt the rest of the day by priority because the previous order no longer fits.");
    }
    if (overflowWeight(feasibility.overflow) < overflowWeight(state.overflow)) state = feasibility;
  } else {
    state = run([...pool].sort(byScore), false);
    explanation.push(
      `Placed tasks by priority score (${cfg.strategy.replace("_", " ")} strategy), demanding tasks in your ${describePeak(cfg.peak)} peak when possible.`,
    );
  }

  const overflow = [...state.overflow, ...lightDrops];
  if (light) {
    // Cap a light day at roughly two thirds of the free time.
    const available = freeMinutes(baseBusy, effectiveStart, input.window.end);
    const cap = Math.round(available * 0.65);
    let used = 0;
    const kept: Placement[] = [];
    for (const p of [...state.placements].sort((a, b) => b.score - a.score)) {
      const d = p.end - p.start;
      if (used + d <= cap || p.reasons.includes("before_deadline")) {
        kept.push(p);
        used += d;
      } else {
        overflow.push({
          taskId: p.taskId,
          title: p.title,
          reason: "light_day",
          detail: "Left out to keep today's load light.",
          estimateMin: d,
          score: p.score,
        });
      }
    }
    state.placements = kept.sort((a, b) => a.start - b.start);
  }

  return finalize(input, cfg, effectiveStart, baseBusy, state.placements, overflow, state.timeline.autoBreaks, lunch, warnings, explanation);
}

function toOverflow(c: Scored, reason: OverflowReason, detail: string): Overflow {
  return { taskId: c.task.id, title: c.task.title, reason, detail, estimateMin: c.task.estimateMin, score: c.score.total };
}

function describePeak(peak: { start: number; end: number }) {
  if (peak.start < 12 * 60) return "morning";
  if (peak.start < 17 * 60) return "afternoon";
  return "evening";
}

function fmt(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function finalize(
  input: PlanInput,
  cfg: EngineConfig,
  effectiveStart: number,
  baseBusy: Busy[],
  placements: Placement[],
  overflow: Overflow[],
  autoBreaks: { start: number; end: number }[],
  lunch: PlanResult["lunch"],
  warnings: string[],
  explanation: string[],
): PlanResult {
  const sorted = [...placements].sort((a, b) => a.start - b.start);
  const fixed = baseBusy.filter((b) => b.kind !== "lunch");
  const availableMin = Math.max(0, freeMinutes(fixed, effectiveStart, input.window.end) - (lunch ? lunch.end - lunch.start : 0));
  const scheduledMin = sorted.reduce((s, p) => s + (p.end - p.start), 0);
  const breakMin = autoBreaks.reduce((s, b) => s + (b.end - b.start), 0);
  const allBusy: Busy[] = [
    ...baseBusy,
    ...sorted.map((p) => ({ start: p.start, end: p.end, kind: "task" as BlockKind, id: p.taskId })),
    ...autoBreaks.map((b) => ({ start: b.start, end: b.end, kind: "auto_break" as BlockKind, id: "b" })),
  ];
  const freeMin = freeMinutes(allBusy, effectiveStart, input.window.end);
  const demandMin = input.tasks
    .filter((t) => t.status !== "done" && t.status !== "cancelled")
    .reduce((s, t) => s + t.estimateMin, 0);
  const realOverflow = overflow.filter((o) => o.reason !== "light_day");
  const overloadMin = realOverflow.reduce((s, o) => s + o.estimateMin, 0);

  let status: DayStatus;
  if (input.date < input.now.date) status = "past";
  else if (demandMin === 0) status = "empty";
  else if (realOverflow.length > 0) status = "overloaded";
  else if (availableMin > 0 && (scheduledMin + breakMin) / availableMin > 0.9) status = "tight";
  else status = "ok";

  if (realOverflow.length > 0) {
    explanation.push(
      `${realOverflow.length} task(s) (${overloadMin} min) do not fit before ${fmt(input.window.end)}: ${realOverflow
        .map((o) => `"${o.title}"`)
        .join(", ")}.`,
    );
  }
  const uniqueWarnings = [...new Set(warnings)];
  return {
    date: input.date,
    mode: input.mode,
    effectiveStart,
    placements: sorted,
    overflow,
    breaks: autoBreaks.map((b) => ({ ...b, label: "Break" })).sort((a, b) => a.start - b.start),
    lunch,
    stats: { windowMin: input.window.end - input.window.start, availableMin, scheduledMin, breakMin, freeMin, demandMin, overloadMin, status },
    explanation,
    warnings: uniqueWarnings,
  };
}

// ---------------------------------------------------------------------------
// Analysis of an existing schedule (no changes)
// ---------------------------------------------------------------------------

export interface Conflict {
  kind: "overlap" | "after_deadline" | "before_dependency" | "outside_window" | "missed";
  taskId: string;
  otherId?: string;
  message: string;
}

export interface AnalyzeInput {
  date: string;
  now: { date: string; minutes: number };
  window: { start: number; end: number };
  blocks: EngineBlock[];
  tasks: EngineTask[];
  dependencies: Record<string, DependencyInfo>;
  config: EngineConfig;
}

export interface DayAnalysis {
  conflicts: Conflict[];
  availableMin: number;
  remainingDemandMin: number;
  scheduledRemainingMin: number;
  unscheduledMin: number;
  overloadMin: number;
  status: DayStatus;
}

export function analyzeDay(input: AnalyzeInput): DayAnalysis {
  const conflicts: Conflict[] = [];
  const open = input.tasks.filter((t) => t.status !== "done" && t.status !== "cancelled");
  const timed = open
    .map((t) => ({ t, p: placementOnDate(t, input.date) }))
    .filter((x): x is { t: EngineTask; p: { start: number; end: number } } => x.p !== null)
    .sort((a, b) => a.p.start - b.p.start);
  const effectiveStart = effectiveStartFor(input.date, input.now, input.window);

  for (let i = 0; i < timed.length; i++) {
    const a = timed[i]!;
    for (let j = i + 1; j < timed.length; j++) {
      const b = timed[j]!;
      if (b.p.start >= a.p.end) break;
      conflicts.push({ kind: "overlap", taskId: b.t.id, otherId: a.t.id, message: `"${b.t.title}" overlaps "${a.t.title}".` });
    }
    for (const blk of input.blocks) {
      if (blk.kind === "break") continue;
      if (overlaps(a.p.start, a.p.end, blk.start, blk.end)) {
        conflicts.push({ kind: "overlap", taskId: a.t.id, otherId: blk.id, message: `"${a.t.title}" overlaps "${blk.title}".` });
      }
    }
    if (a.t.dueAt && a.t.dueHard && dateOf(a.t.dueAt) === input.date && a.p.end > minutesOf(a.t.dueAt)) {
      conflicts.push({ kind: "after_deadline", taskId: a.t.id, message: `"${a.t.title}" ends after its deadline (${a.t.dueAt.slice(11)}).` });
    }
    if (a.p.start < input.window.start || a.p.end > input.window.end) {
      conflicts.push({ kind: "outside_window", taskId: a.t.id, message: `"${a.t.title}" is outside your planning hours.` });
    }
    if (input.date === input.now.date && a.p.end <= input.now.minutes) {
      conflicts.push({ kind: "missed", taskId: a.t.id, message: `"${a.t.title}" was planned earlier and is not done.` });
    }
    for (const depId of a.t.dependsOn) {
      const depTimed = timed.find((x) => x.t.id === depId);
      if (depTimed && depTimed.p.end > a.p.start) {
        conflicts.push({ kind: "before_dependency", taskId: a.t.id, otherId: depId, message: `"${a.t.title}" starts before "${depTimed.t.title}" ends.` });
      }
    }
  }

  const fixedBusy: Busy[] = input.blocks.map((b) => ({ start: b.start, end: b.end, kind: b.kind, id: b.id }));
  for (const t of open) {
    if (!t.pinned) continue;
    const p = placementOnDate(t, input.date);
    if (p) fixedBusy.push({ start: p.start, end: p.end, kind: "pinned", id: t.id });
  }
  const availableMin = input.date < input.now.date ? 0 : freeMinutes(fixedBusy, effectiveStart, input.window.end);
  let scheduledRemainingMin = 0;
  let unscheduledMin = 0;
  for (const t of open) {
    const p = placementOnDate(t, input.date);
    if (t.pinned && p) continue; // already excluded from available time
    if (p && p.end <= effectiveStart) {
      unscheduledMin += t.estimateMin; // missed: still needs time
    } else if (p) {
      scheduledRemainingMin += p.end - Math.max(p.start, effectiveStart);
    } else unscheduledMin += t.estimateMin;
  }
  const remainingDemandMin = scheduledRemainingMin + unscheduledMin;
  const overloadMin = Math.max(0, remainingDemandMin - availableMin);
  let status: DayStatus;
  if (input.date < input.now.date) status = "past";
  else if (open.length === 0) status = "empty";
  else if (overloadMin > 0) status = "overloaded";
  else if (availableMin > 0 && remainingDemandMin / availableMin > 0.85) status = "tight";
  else status = "ok";
  return { conflicts, availableMin, remainingDemandMin, scheduledRemainingMin, unscheduledMin, overloadMin, status };
}

// ---------------------------------------------------------------------------
// Free time search
// ---------------------------------------------------------------------------

export function freeBlocks(
  window: { start: number; end: number },
  busy: { start: number; end: number }[],
  from: number,
  minMinutes: number,
): { start: number; end: number }[] {
  const sorted = busy.filter((b) => b.end > from).sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  let cursor = Math.max(window.start, from);
  for (const b of sorted) {
    if (b.start > cursor) {
      const end = Math.min(b.start, window.end);
      if (end - cursor >= minMinutes) out.push({ start: cursor, end });
    }
    cursor = Math.max(cursor, b.end);
    if (cursor >= window.end) break;
  }
  if (window.end - cursor >= minMinutes) out.push({ start: cursor, end: window.end });
  return out;
}
