import { Coffee, Lock, Pin, Utensils } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import type { Conflict, DayView } from "@shared/api";
import type { Task } from "@shared/schemas";
import { combine, dateOf, formatDuration, fromMinutes, minutesOf, toMinutes } from "@shared/time";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { layoutColumns, snap } from "../lib/layout";
import { useAction } from "../lib/queries";
import { useUi } from "../lib/store";
import { patchTaskInCaches, taskState } from "../lib/tasks";
import { useQueryClient } from "@tanstack/react-query";
import { PriorityIcon, TaskCheckbox, useTaskActions, type RowContext } from "./task";

const PX_PER_MIN = 1.3;
const MIN_BLOCK = 18;

type Block =
  | { kind: "task"; id: string; task: Task; start: number; end: number }
  | { kind: "event"; id: string; title: string; start: number; end: number; eventKind: string; location: string; seriesId: string; occurrence: string }
  | { kind: "break"; id: string; title: string; start: number; end: number; lunch: boolean };

interface DragState {
  id: string;
  mode: "move" | "resize";
  originY: number;
  start: number;
  end: number;
  moved: boolean;
}

export function DayTimeline({ view, ctx, conflicts }: { view: DayView; ctx: RowContext; conflicts: Conflict[] }) {
  const t = useT();
  const ui = useUi();
  const qc = useQueryClient();
  const run = useAction();
  const actions = useTaskActions();
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const isToday = view.date === view.today;
  const nowMin = minutesOf(view.now);

  const blocks = useMemo<Block[]>(() => {
    const out: Block[] = [];
    for (const task of view.tasks) {
      if (!task.scheduledStart || dateOf(task.scheduledStart) !== view.date) continue;
      const start = minutesOf(task.scheduledStart);
      const end = task.scheduledEnd ? minutesOf(task.scheduledEnd) : start + task.estimateMin;
      out.push({ kind: "task", id: task.id, task, start, end: Math.max(end, start + 5) });
    }
    for (const e of view.events) {
      if (e.allDay) continue;
      out.push({
        kind: "event",
        id: `${e.id}@${e.occurrenceDate}`,
        title: e.title,
        start: toMinutes(e.start),
        end: toMinutes(e.end),
        eventKind: e.kind,
        location: e.location,
        seriesId: e.seriesId,
        occurrence: e.occurrenceDate,
      });
    }
    for (const [i, b] of view.plan.breaks.entries()) {
      out.push({ kind: "break", id: `brk${i}`, title: b.label, start: toMinutes(b.start), end: toMinutes(b.end), lunch: b.label === "Lunch" });
    }
    return out;
  }, [view]);

  const windowStart = toMinutes(view.window.start);
  const windowEnd = toMinutes(view.window.end);
  const earliest = Math.min(windowStart, ...blocks.map((b) => b.start));
  const latest = Math.max(windowEnd, ...blocks.map((b) => b.end));
  const axisStart = Math.max(0, Math.floor(earliest / 60) * 60);
  const axisEnd = Math.min(24 * 60, Math.ceil(latest / 60) * 60);
  const height = (axisEnd - axisStart) * PX_PER_MIN;
  const y = (m: number) => (m - axisStart) * PX_PER_MIN;

  // The timeline scrolls inside its own card; bring "now" (or the first block) into view.
  const scroller = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const focus = isToday ? nowMin - 60 : Math.min(...blocks.map((b) => b.start), windowStart) - 30;
    el.scrollTop = Math.max(0, y(Math.max(axisStart, focus)) - 24);
    // only when the day changes, so manual scrolling is never overridden
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.date]);

  // Open stretches of at least 30 minutes left in the planning window, shown as free time.
  const freeGaps = useMemo(() => {
    const from = isToday ? Math.max(windowStart, Math.ceil(nowMin / 5) * 5) : windowStart;
    if (view.date < view.today) return [];
    const busy = blocks
      .filter((b) => !(b.kind === "task" && b.task.status === "done" && b.end <= from))
      .map((b) => ({ start: b.start, end: b.end }))
      .sort((a, b) => a.start - b.start);
    const gaps: { start: number; end: number }[] = [];
    let cursor = from;
    for (const b of busy) {
      if (b.start - cursor >= 30) gaps.push({ start: cursor, end: Math.min(b.start, windowEnd) });
      cursor = Math.max(cursor, b.end);
      if (cursor >= windowEnd) break;
    }
    if (windowEnd - cursor >= 30) gaps.push({ start: cursor, end: windowEnd });
    return gaps.filter((g) => g.end - g.start >= 30);
  }, [blocks, isToday, nowMin, windowStart, windowEnd, view.date, view.today]);

  const laid = layoutColumns(
    blocks.map((b) => {
      if (drag && b.kind === "task" && b.id === drag.id) return { item: b, start: drag.start, end: drag.end };
      return { item: b, start: b.start, end: b.end };
    }),
  );
  const conflictIds = new Set(conflicts.filter((c) => c.kind === "overlap" || c.kind === "after_deadline" || c.kind === "before_dependency").flatMap((c) => [c.taskId, c.otherId ?? ""]));
  const hours: number[] = [];
  for (let h = axisStart; h <= axisEnd; h += 60) hours.push(h);

  const minuteFromClientY = (clientY: number) => {
    const rect = gridRef.current!.getBoundingClientRect();
    return axisStart + (clientY - rect.top) / PX_PER_MIN;
  };

  const onPointerDown = (e: RPointerEvent, b: Extract<Block, { kind: "task" }>, mode: DragState["mode"]) => {
    if (e.button !== 0 || b.task.status === "done") return;
    if ((e.target as HTMLElement).closest("button") && mode === "move") return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ id: b.id, mode, originY: e.clientY, start: b.start, end: b.end, moved: false });
  };

  const onPointerMove = (e: RPointerEvent) => {
    if (!drag) return;
    const original = blocks.find((b) => b.id === drag.id)!;
    const delta = (e.clientY - drag.originY) / PX_PER_MIN;
    if (drag.mode === "move") {
      const dur = original.end - original.start;
      const start = Math.max(0, Math.min(24 * 60 - dur, snap(original.start + delta)));
      setDrag({ ...drag, start, end: start + dur, moved: drag.moved || Math.abs(delta) > 2 });
    } else {
      const end = Math.max(original.start + 10, Math.min(24 * 60 - 1, snap(original.end + delta)));
      setDrag({ ...drag, end, moved: drag.moved || Math.abs(delta) > 2 });
    }
  };

  const onPointerUp = async () => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    const original = blocks.find((b) => b.id === d.id) as Extract<Block, { kind: "task" }> | undefined;
    if (!original) return;
    if (!d.moved) {
      ui.set({ editingTaskId: original.id });
      return;
    }
    if (d.mode === "move" && d.start !== original.start) {
      patchTaskInCaches(qc, original.id, { scheduledStart: combine(view.date, fromMinutes(d.start)), scheduledEnd: combine(view.date, fromMinutes(d.end)), pinned: true });
      await run(() => api.scheduleTask(original.id, view.date, fromMinutes(d.start), true), {
        success: t("toast.scheduled", { time: fromMinutes(d.start) }),
        undoLabel: t("common.undo"),
      });
    } else if (d.mode === "resize" && d.end !== original.end) {
      patchTaskInCaches(qc, original.id, { scheduledEnd: combine(view.date, fromMinutes(d.end)), estimateMin: d.end - original.start });
      await run(() => api.updateTask(original.id, { scheduledEnd: combine(view.date, fromMinutes(d.end)) }), { success: t("toast.saved"), undoLabel: t("common.undo") });
    }
  };

  return (
    <div className="tl" aria-label={t("today.view.timeline")} ref={scroller}>
      <div
        className="tl-grid"
        ref={gridRef}
        style={{ height }}
        onPointerMove={onPointerMove}
        onPointerUp={() => void onPointerUp()}
        onPointerCancel={() => setDrag(null)}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("text/aura-task")) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setDropAt(Math.max(axisStart, Math.min(axisEnd - 15, snap(minuteFromClientY(e.clientY), 15))));
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropAt(null);
        }}
        onDrop={(e) => {
          const id = e.dataTransfer.getData("text/aura-task");
          const at = dropAt;
          setDropAt(null);
          if (!id || at === null) return;
          e.preventDefault();
          void run(() => api.scheduleTask(id, view.date, fromMinutes(at), true), { success: t("toast.scheduled", { time: fromMinutes(at) }), undoLabel: t("common.undo") });
        }}
        onDoubleClick={(e) => {
          if (e.target !== e.currentTarget && !(e.target as HTMLElement).classList.contains("tl-slot")) return;
          const at = snap(minuteFromClientY(e.clientY), 15);
          ui.set({ quickAdd: { plannedDate: view.date, start: fromMinutes(at) } });
        }}
      >
        {hours.map((h) => (
          <div key={h} className="tl-hour" style={{ top: y(h) }}>
            <span className="tl-hour-label tnum">{fromMinutes(h)}</span>
          </div>
        ))}
        {/* Outside planning hours */}
        {windowStart > axisStart && <div className="tl-off" style={{ top: 0, height: y(windowStart) }} />}
        {windowEnd < axisEnd && <div className="tl-off" style={{ top: y(windowEnd), height: height - y(windowEnd) }} />}
        <div className="tl-slot" />
        {isToday && nowMin > axisStart && <div className="tl-past" style={{ top: 0, height: y(Math.min(nowMin, axisEnd)) }} aria-hidden />}
        {!drag &&
          freeGaps.map((g) => (
            <button
              key={`free-${g.start}`}
              type="button"
              className="tl-free"
              style={{ top: y(g.start) + 3, height: Math.max(20, (g.end - g.start) * PX_PER_MIN - 6) }}
              onClick={() => ui.set({ quickAdd: { plannedDate: view.date, start: fromMinutes(g.start) } })}
              title={t("today.freeAdd")}
            >
              <span className="tnum">{t("today.free", { time: formatDuration(g.end - g.start) })}</span>
            </button>
          ))}

        {laid.map(({ item: b, start, end, col, cols }) => {
          const top = y(start);
          const h = Math.max(MIN_BLOCK, (end - start) * PX_PER_MIN - 2);
          const style = { top, height: h, left: `calc(var(--tl-gutter) + (100% - var(--tl-gutter)) * ${col / cols})`, width: `calc((100% - var(--tl-gutter)) / ${cols} - 6px)` };
          const compact = h < 46;
          const tiny = h < 26;
          if (b.kind === "event") {
            return (
              <button
                key={b.id}
                type="button"
                className={`tl-block tl-event tl-event-${b.eventKind} ${compact ? "is-compact" : ""}`}
                style={style}
                onClick={() => ui.set({ editingEvent: { id: b.seriesId, date: b.occurrence, start: fromMinutes(b.start), end: fromMinutes(b.end), occurrence: b.occurrence } })}
              >
                <span className="tl-block-title truncate">
                  <Lock className="tl-icon" />
                  {b.title}
                </span>
                <span className="tl-block-time tnum">
                  {fromMinutes(b.start)}–{fromMinutes(b.end)}
                  {b.location ? ` · ${b.location}` : ""}
                </span>
              </button>
            );
          }
          if (b.kind === "break") {
            return (
              <div key={b.id} className={`tl-block tl-break ${compact ? "is-compact" : ""}`} style={style}>
                <span className="tl-block-title truncate">
                  {b.lunch ? <Utensils className="tl-icon" /> : <Coffee className="tl-icon" />}
                  {b.lunch ? t("today.lunch") : t("today.break")}
                </span>
                <span className="tl-block-time tnum">
                  {fromMinutes(b.start)}–{fromMinutes(b.end)}
                </span>
              </div>
            );
          }
          const task = b.task;
          const s = taskState(task, ctx.now, ctx.statusById);
          const project = task.projectId ? ctx.projects.get(task.projectId) : undefined;
          const dragging = drag?.id === b.id;
          const cls = [
            "tl-block",
            "tl-task",
            tiny ? "is-tiny" : "",
            `tl-prio-${task.priority}`,
            s.done ? "is-done" : "",
            s.missed ? "is-missed" : "",
            s.now ? "is-now" : "",
            conflictIds.has(task.id) ? "is-conflict" : "",
            compact ? "is-compact" : "",
            dragging ? "is-dragging" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <div
              key={b.id}
              className={cls}
              style={style}
              role="button"
              tabIndex={0}
              aria-label={`${task.title}, ${fromMinutes(start)}–${fromMinutes(end)}`}
              onPointerDown={(e) => onPointerDown(e, b, "move")}
              onKeyDown={(e) => {
                if (e.key === "Enter") ui.set({ editingTaskId: task.id });
                if (e.key === " ") {
                  e.preventDefault();
                  void actions.toggle(task, view.today);
                }
              }}
            >
              <div className="tl-task-head">
                <TaskCheckbox task={task} size={15} onToggle={() => void actions.toggle(task, view.today)} />
                <span className="tl-block-title truncate">{task.title}</span>
                {task.pinned && !compact && <Pin className="tl-icon tl-pin" aria-label={t("state.pinned")} />}
              </div>
              {!compact && (
                <div className="tl-task-meta">
                  <PriorityIcon priority={task.priority} size={11} />
                  <span className="tnum">
                    {fromMinutes(start)}–{fromMinutes(end)}
                  </span>
                  <span className="tnum">{formatDuration(end - start)}</span>
                  {project && (
                    <span className="tl-project truncate">
                      <span className="dot" style={{ background: project.color, width: 6, height: 6 }} />
                      {project.name}
                    </span>
                  )}
                  {s.missed && <span className="tl-flag tl-flag-warning">{t("state.missed")}</span>}
                  {s.now && <span className="tl-flag tl-flag-accent">{t("state.now")}</span>}
                </div>
              )}
              {task.status !== "done" && <div className="tl-resize" onPointerDown={(e) => onPointerDown(e, b, "resize")} aria-hidden />}
            </div>
          );
        })}

        {isToday && nowMin >= axisStart && nowMin <= axisEnd && (
          <div className="tl-now" style={{ top: y(nowMin) }} aria-label={t("today.now")}>
            <span className="tl-now-label tnum">{fromMinutes(nowMin)}</span>
          </div>
        )}

        {dropAt !== null && (
          <div className="tl-drop" style={{ top: y(dropAt) }}>
            <span>{t("today.dropHere", { time: fromMinutes(dropAt) })}</span>
          </div>
        )}
      </div>
    </div>
  );
}
