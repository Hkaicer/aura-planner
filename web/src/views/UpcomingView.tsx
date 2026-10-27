import { Lock, Plus } from "lucide-react";
import type { RangeDay } from "@shared/api";
import { addDays, formatDuration } from "@shared/time";
import { TaskRow, useRowContext } from "../components/task";
import { Badge, ErrorState } from "../components/ui";
import { ViewHeader } from "../components/ViewHeader";
import { fmtDate, relativeDay } from "../lib/format";
import { useLang, useT, type Key } from "../lib/i18n";
import { errorMessage, useNow, useProjects, useRange, useTasks } from "../lib/queries";
import { useUi } from "../lib/store";

export function UpcomingView() {
  const t = useT();
  const now = useNow();
  const from = now.date;
  const to = addDays(now.date, 13);
  const range = useRange(from, to);
  const projects = useProjects();
  const all = useTasks("all");
  const ctx = useRowContext([], projects.data, now, all.data);
  return (
    <>
      <ViewHeader title={t("upcoming.title")} sub={t("upcoming.subtitle")} />
      <div className="view-body">
        <div className="view-inner view-inner-narrow">
          {range.isLoading && <div className="skeleton" style={{ height: 400, borderRadius: 12 }} />}
          {range.isError && <ErrorState message={errorMessage(range.error)} onRetry={() => void range.refetch()} />}
          {range.data?.map((d) => <UpcomingDay key={d.date} day={d} ctx={ctx} today={now.date} />)}
        </div>
      </div>
    </>
  );
}

function UpcomingDay({ day, ctx, today }: { day: RangeDay; ctx: ReturnType<typeof useRowContext>; today: string }) {
  const t = useT();
  const lang = useLang();
  const ui = useUi();
  const tasks = [...day.tasks].sort((a, b) => Number(a.status === "done") - Number(b.status === "done") || (a.scheduledStart ?? "~").localeCompare(b.scheduledStart ?? "~") || a.position - b.position);
  const events = day.events.filter((e) => !e.allDay);
  const allDay = day.events.filter((e) => e.allDay);
  const a = day.analysis;
  const load = a.availableMin > 0 ? Math.min(1, a.remainingDemandMin / a.availableMin) : a.remainingDemandMin > 0 ? 1 : 0;
  const tone = a.status === "overloaded" ? "danger" : a.status === "tight" ? "warning" : "success";
  const isToday = day.date === today;
  return (
    <section className={`upcoming-day ${isToday ? "is-today" : ""}`}>
      <header className="upcoming-head">
        <div className="upcoming-date">
          <span className="upcoming-rel">{relativeDay(day.date, today, lang, t)}</span>
          <span className="faint">{fmtDate(day.date, lang, { day: "numeric", month: "long" })}</span>
        </div>
        <span className="spacer" />
        {(tasks.length > 0 || events.length > 0) && a.status !== "empty" && (
          <>
            <span className="faint tnum upcoming-load-text">{t("upcoming.load", { demand: formatDuration(a.remainingDemandMin), available: formatDuration(a.availableMin) })}</span>
            <div className={`load-bar load-${tone}`} title={t(`day.status.${a.status}` as Key)}>
              <span style={{ width: `${Math.round(load * 100)}%` }} />
            </div>
            {a.status === "overloaded" && <Badge tone="danger">{t("day.status.overloaded")}</Badge>}
          </>
        )}
        <button type="button" className="icon-btn icon-btn-sm" aria-label={t("upcoming.addHere")} data-tip={t("upcoming.addHere")} onClick={() => ui.set({ quickAdd: { plannedDate: day.date } })}>
          <Plus />
        </button>
      </header>
      {allDay.map((e) => (
        <div key={e.id + e.occurrenceDate} className="upcoming-allday">
          {e.title}
        </div>
      ))}
      {events.length > 0 && (
        <div className="upcoming-events">
          {events.map((e) => (
            <button
              key={e.id + e.occurrenceDate}
              type="button"
              className="event-pill"
              onClick={() => ui.set({ editingEvent: { id: e.seriesId, date: e.occurrenceDate, start: e.start, end: e.end, occurrence: e.occurrenceDate } })}
            >
              <Lock />
              <span className="tnum">
                {e.start}–{e.end}
              </span>
              <span className="truncate">{e.title}</span>
            </button>
          ))}
        </div>
      )}
      {tasks.length > 0 ? (
        <div className="task-list">
          {tasks.map((task) => (
            <TaskRow key={task.id} task={task} ctx={ctx} />
          ))}
        </div>
      ) : (
        events.length === 0 && <div className="upcoming-empty faint">{t("upcoming.empty")}</div>
      )}
    </section>
  );
}
