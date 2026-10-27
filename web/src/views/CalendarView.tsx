import { CalendarPlus, ChevronLeft, ChevronRight, Download, Lock, Plus, Repeat, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import type { RangeDay } from "@shared/api";
import type { EventOccurrence, Task } from "@shared/schemas";
import { addDays, combine, dateOf, fromMinutes, minutesOf, toMinutes } from "@shared/time";
import { TaskCheckbox, useRowContext, useTaskActions } from "../components/task";
import { Button, ErrorState, IconButton, Segmented } from "../components/ui";
import { ViewHeader } from "../components/ViewHeader";
import { api } from "../lib/api";
import { fmtDate, weekDates } from "../lib/format";
import { useLang, useT } from "../lib/i18n";
import { layoutColumns, snap } from "../lib/layout";
import { errorMessage, invalidatePlanning, useAction, useNow, useProjects, useRange, useTasks } from "../lib/queries";
import { useUi } from "../lib/store";
import { taskState } from "../lib/tasks";
import { toast } from "../lib/toast";
import { useQueryClient } from "@tanstack/react-query";

const PX = 0.8; // pixels per minute

type Item =
  | { kind: "task"; key: string; date: string; start: number; end: number; task: Task }
  | { kind: "event"; key: string; date: string; start: number; end: number; event: EventOccurrence };

interface Drag {
  key: string;
  mode: "move" | "resize";
  x0: number;
  y0: number;
  date: string;
  start: number;
  end: number;
  moved: boolean;
}

export function CalendarView() {
  const t = useT();
  const lang = useLang();
  const ui = useUi();
  const now = useNow();
  const qc = useQueryClient();
  const anchor = ui.calendarDate ?? now.date;
  const mode = ui.calendarMode;
  const days = mode === "week" ? weekDates(anchor) : [anchor];
  const range = useRange(days[0]!, days[days.length - 1]!);
  const projects = useProjects();
  const all = useTasks("all");
  const ctx = useRowContext([], projects.data, now, all.data);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const step = mode === "week" ? 7 : 1;
  const title =
    mode === "week"
      ? `${fmtDate(days[0]!, lang, { day: "numeric", month: "short" })} – ${fmtDate(days[6]!, lang, { day: "numeric", month: "short", year: "numeric" })}`
      : fmtDate(anchor, lang, { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  const importIcs = async (file: File) => {
    try {
      const text = await file.text();
      const res = await api.importIcs(text);
      invalidatePlanning(qc);
      toast.show({
        message: t("calendar.imported", { n: res.imported }),
        ...(res.historyId ? { action: { label: t("common.undo"), run: async () => { await api.undo(res.historyId!); invalidatePlanning(qc); } } } : {}),
      });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <>
      <ViewHeader
        title={t("calendar.title")}
        sub={title}
        actions={
          <>
            <div className="row" style={{ gap: 2 }}>
              <IconButton label={t("calendar.prev")} onClick={() => ui.set({ calendarDate: addDays(anchor, -step) })}>
                <ChevronLeft />
              </IconButton>
              <Button size="sm" onClick={() => ui.set({ calendarDate: null })}>
                {t("common.today")}
              </Button>
              <IconButton label={t("calendar.next")} onClick={() => ui.set({ calendarDate: addDays(anchor, step) })}>
                <ChevronRight />
              </IconButton>
            </div>
            <Segmented
              label={t("calendar.title")}
              value={mode}
              onChange={(v) => ui.set({ calendarMode: v })}
              options={[
                { value: "day", label: t("calendar.day") },
                { value: "week", label: t("calendar.week") },
              ]}
            />
            <IconButton label={t("calendar.newEvent")} onClick={() => ui.set({ editingEvent: { id: null, date: anchor, start: "09:00", end: "10:00" } })}>
              <CalendarPlus />
            </IconButton>
            <IconButton label={t("calendar.import")} onClick={() => fileRef.current?.click()}>
              <Upload />
            </IconButton>
            <IconButton label={t("calendar.export")} onClick={() => window.open("/api/calendar/export.ics", "_blank")}>
              <Download />
            </IconButton>
            <input
              ref={fileRef}
              type="file"
              accept=".ics,text/calendar"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importIcs(f);
                e.target.value = "";
              }}
            />
          </>
        }
      />
      <div className="view-body cal-body">
        {range.isError && <ErrorState message={errorMessage(range.error)} onRetry={() => void range.refetch()} />}
        {range.data && <CalendarGrid days={range.data} today={now.date} nowMin={now.minutes} ctx={ctx} />}
        {range.isLoading && <div className="skeleton" style={{ height: 600, margin: 24, borderRadius: 12 }} />}
      </div>
    </>
  );
}

function CalendarGrid({ days, today, nowMin, ctx }: { days: RangeDay[]; today: string; nowMin: number; ctx: ReturnType<typeof useRowContext> }) {
  const t = useT();
  const lang = useLang();
  const ui = useUi();
  const run = useAction();
  const actions = useTaskActions();
  const colsRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [creating, setCreating] = useState<{ date: string; start: number; x: number; y: number } | null>(null);

  useEffect(() => {
    const el = scrollRef.current?.closest(".view-body") as HTMLElement | null;
    if (el) el.scrollTop = 7 * 60 * PX;
  }, []);

  const items = useMemo(() => {
    const out: Item[] = [];
    for (const d of days) {
      for (const task of d.tasks) {
        if (!task.scheduledStart || dateOf(task.scheduledStart) !== d.date) continue;
        const start = minutesOf(task.scheduledStart);
        out.push({ kind: "task", key: `t:${task.id}`, date: d.date, start, end: task.scheduledEnd ? minutesOf(task.scheduledEnd) : start + task.estimateMin, task });
      }
      for (const e of d.events) {
        if (e.allDay) continue;
        out.push({ kind: "event", key: `e:${e.id}:${e.occurrenceDate}`, date: d.date, start: toMinutes(e.start), end: toMinutes(e.end), event: e });
      }
    }
    return out;
  }, [days]);

  const colWidth = () => (colsRef.current ? colsRef.current.getBoundingClientRect().width / days.length : 1);

  const onDown = (e: RPointerEvent, it: Item, mode: Drag["mode"]) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    if (it.kind === "task" && it.task.status === "done") return;
    if (it.kind === "event" && it.event.recurrence) return; // recurring series are edited in the dialog
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ key: it.key, mode, x0: e.clientX, y0: e.clientY, date: it.date, start: it.start, end: it.end, moved: false });
  };

  const onMove = (e: RPointerEvent) => {
    if (!drag) return;
    const it = items.find((x) => x.key === drag.key)!;
    const dy = (e.clientY - drag.y0) / PX;
    const moved = drag.moved || Math.abs(e.clientY - drag.y0) > 3 || Math.abs(e.clientX - drag.x0) > 3;
    if (drag.mode === "resize") {
      setDrag({ ...drag, end: Math.max(it.start + 10, Math.min(1439, snap(it.end + dy))), moved });
      return;
    }
    const dur = it.end - it.start;
    const start = Math.max(0, Math.min(1440 - dur, snap(it.start + dy, 5)));
    const dayShift = days.length > 1 ? Math.round((e.clientX - drag.x0) / colWidth()) : 0;
    const idx = Math.max(0, Math.min(days.length - 1, days.findIndex((d) => d.date === it.date) + dayShift));
    setDrag({ ...drag, start, end: start + dur, date: days[idx]!.date, moved });
  };

  const onUp = async () => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    const it = items.find((x) => x.key === d.key);
    if (!it) return;
    if (!d.moved) {
      if (it.kind === "task") ui.set({ editingTaskId: it.task.id });
      else ui.set({ editingEvent: { id: it.event.seriesId, date: it.event.occurrenceDate, start: it.event.start, end: it.event.end, occurrence: it.event.occurrenceDate } });
      return;
    }
    if (it.kind === "task") {
      if (d.mode === "resize") await run(() => api.updateTask(it.task.id, { scheduledEnd: combine(it.date, fromMinutes(d.end)) }), { success: t("toast.saved"), undoLabel: t("common.undo") });
      else await run(() => api.scheduleTask(it.task.id, d.date, fromMinutes(d.start), true), { success: t("toast.scheduled", { time: fromMinutes(d.start) }), undoLabel: t("common.undo") });
    } else {
      await run(() => api.updateEvent(it.event.id, { date: d.date, start: fromMinutes(d.start), end: fromMinutes(d.end) }), { success: t("toast.saved"), undoLabel: t("common.undo") });
    }
  };

  const hours = Array.from({ length: 25 }, (_, i) => i * 60);

  return (
    <div className="cal" ref={scrollRef}>
      <div className="cal-head" style={{ gridTemplateColumns: `var(--cal-gutter) repeat(${days.length}, minmax(0, 1fr))` }}>
        <div />
        {days.map((d) => {
          const allDay = d.events.filter((e) => e.allDay);
          const load = d.analysis.availableMin > 0 ? d.analysis.remainingDemandMin / d.analysis.availableMin : 0;
          return (
            <div key={d.date} className={`cal-day-head ${d.date === today ? "is-today" : ""}`}>
              <button type="button" className="cal-day-label" onClick={() => ui.set({ calendarDate: d.date, calendarMode: "day" })}>
                <span className="cal-wd">{fmtDate(d.date, lang, { weekday: "short" })}</span>
                <span className="cal-dn tnum">{fmtDate(d.date, lang, { day: "numeric" })}</span>
              </button>
              {d.analysis.status !== "empty" && d.analysis.status !== "past" && (
                <div className={`load-bar load-${d.analysis.status === "overloaded" ? "danger" : d.analysis.status === "tight" ? "warning" : "success"}`} title={t(`day.status.${d.analysis.status}`)}>
                  <span style={{ width: `${Math.min(100, Math.round(load * 100))}%` }} />
                </div>
              )}
              {allDay.map((e) => (
                <div key={e.id} className="cal-allday truncate">
                  {e.title}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      <div className="cal-grid" style={{ height: 1440 * PX }} onPointerMove={onMove} onPointerUp={() => void onUp()} onPointerCancel={() => setDrag(null)}>
        <div className="cal-gutter">
          {hours.map((h) => (
            <span key={h} className="cal-hour-label tnum" style={{ top: h * PX }}>
              {h > 0 && h < 1440 ? fromMinutes(h) : ""}
            </span>
          ))}
        </div>
        <div className="cal-cols" ref={colsRef} style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
          {days.map((d) => {
            const ws = toMinutes(d.window.start);
            const we = toMinutes(d.window.end);
            const dayItems = items
              .map((it) => (drag && it.key === drag.key ? { ...it, date: drag.date, start: drag.start, end: drag.end } : it))
              .filter((it) => it.date === d.date);
            const laid = layoutColumns(dayItems.map((it) => ({ item: it, start: it.start, end: it.end })));
            return (
              <div
                key={d.date}
                className={`cal-col ${d.date === today ? "is-today" : ""}`}
                onDoubleClick={(e) => {
                  if (e.target !== e.currentTarget && !(e.target as HTMLElement).classList.contains("cal-hours-bg")) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const start = snap((e.clientY - rect.top) / PX, 15);
                  setCreating({ date: d.date, start, x: e.clientX, y: e.clientY });
                }}
              >
                <div className="cal-hours-bg" />
                {ws > 0 && <div className="cal-off" style={{ top: 0, height: ws * PX }} />}
                {we < 1440 && <div className="cal-off" style={{ top: we * PX, height: (1440 - we) * PX }} />}
                {laid.map(({ item: it, col, cols }) => {
                  const top = it.start * PX;
                  const height = Math.max(18, (it.end - it.start) * PX - 2);
                  const style = { top, height, left: `calc(${(col / cols) * 100}% + 2px)`, width: `calc(${100 / cols}% - 4px)` };
                  if (it.kind === "event") {
                    return (
                      <div key={it.key} className={`cal-item cal-event cal-event-${it.event.kind} ${drag?.key === it.key ? "is-dragging" : ""}`} style={style} onPointerDown={(e) => onDown(e, it, "move")} role="button" tabIndex={0}>
                        <span className="cal-item-title truncate">
                          {it.event.recurrence ? <Repeat className="cal-icon" /> : <Lock className="cal-icon" />}
                          {it.event.title}
                        </span>
                        {height > 30 && (
                          <span className="cal-item-time tnum">
                            {fromMinutes(it.start)}–{fromMinutes(it.end)}
                          </span>
                        )}
                        {!it.event.recurrence && <div className="cal-resize" onPointerDown={(e) => onDown(e, it, "resize")} />}
                      </div>
                    );
                  }
                  const s = taskState(it.task, ctx.now, ctx.statusById);
                  const project = it.task.projectId ? ctx.projects.get(it.task.projectId) : undefined;
                  return (
                    <div
                      key={it.key}
                      className={`cal-item cal-task tl-prio-${it.task.priority} ${s.done ? "is-done" : ""} ${s.missed ? "is-missed" : ""} ${drag?.key === it.key ? "is-dragging" : ""}`}
                      style={{ ...style, ...(project ? { ["--project" as string]: project.color } : {}) }}
                      onPointerDown={(e) => onDown(e, it, "move")}
                      role="button"
                      tabIndex={0}
                      aria-label={it.task.title}
                    >
                      <span className="cal-item-title truncate">
                        <TaskCheckbox task={it.task} size={12} onToggle={() => void actions.toggle(it.task, today)} />
                        {it.task.title}
                      </span>
                      {height > 30 && (
                        <span className="cal-item-time tnum">
                          {fromMinutes(it.start)}–{fromMinutes(it.end)}
                        </span>
                      )}
                      {!s.done && <div className="cal-resize" onPointerDown={(e) => onDown(e, it, "resize")} />}
                    </div>
                  );
                })}
                {d.date === today && <div className="cal-now" style={{ top: nowMin * PX }} />}
              </div>
            );
          })}
        </div>
        {hours.map((h) => (
          <div key={h} className="cal-line" style={{ top: h * PX }} />
        ))}
      </div>
      {creating && (
        <CreateMenu
          x={creating.x}
          y={creating.y}
          onClose={() => setCreating(null)}
          onTask={() => ui.set({ quickAdd: { plannedDate: creating.date, start: fromMinutes(creating.start) } })}
          onEvent={() => ui.set({ editingEvent: { id: null, date: creating.date, start: fromMinutes(creating.start), end: fromMinutes(Math.min(1439, creating.start + 60)) } })}
          label={`${fmtDate(creating.date, lang, { weekday: "short", day: "numeric" })} ${fromMinutes(creating.start)}`}
        />
      )}
    </div>
  );
}

function CreateMenu({ x, y, onClose, onTask, onEvent, label }: { x: number; y: number; onClose: () => void; onTask: () => void; onEvent: () => void; label: string }) {
  const t = useT();
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    ref.current?.querySelector("button")?.focus();
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="popover" style={{ position: "fixed", top: Math.min(y, window.innerHeight - 120), left: Math.min(x, window.innerWidth - 220) }} role="menu">
      <div className="menu-label">{label}</div>
      <button type="button" className="menu-item" role="menuitem" onClick={() => { onClose(); onTask(); }}>
        <Plus />
        {t("calendar.task")}
      </button>
      <button type="button" className="menu-item" role="menuitem" onClick={() => { onClose(); onEvent(); }}>
        <CalendarPlus />
        {t("calendar.event")}
      </button>
    </div>
  );
}
