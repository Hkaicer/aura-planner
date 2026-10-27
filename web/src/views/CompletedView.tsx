import { CheckCircle2, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import type { StatsSummary } from "@shared/api";
import type { Task } from "@shared/schemas";
import { formatDuration, zonedNow } from "@shared/time";
import { PriorityIcon } from "../components/task";
import { Empty, ErrorState, IconButton } from "../components/ui";
import { ViewHeader } from "../components/ViewHeader";
import { api } from "../lib/api";
import { fmtDate, relativeDay } from "../lib/format";
import { useLang, useT } from "../lib/i18n";
import { errorMessage, useAction, useNow, useProjects, useSettings, useStats, useTasks } from "../lib/queries";
import { useUi } from "../lib/store";

export function CompletedView() {
  const t = useT();
  const lang = useLang();
  const ui = useUi();
  const now = useNow();
  const settings = useSettings();
  const done = useTasks("done");
  const stats = useStats();
  const projects = useProjects();
  const run = useAction();
  const tz = settings?.timeZone ?? "UTC";
  const projectById = new Map((projects.data ?? []).map((p) => [p.id, p]));

  const groups = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of [...(done.data ?? [])].sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))) {
      const day = task.completedAt ? zonedNow(tz, new Date(task.completedAt)).date : "unknown";
      map.set(day, [...(map.get(day) ?? []), task]);
    }
    return [...map.entries()];
  }, [done.data, tz]);

  return (
    <>
      <ViewHeader title={t("completed.title")} sub={done.data ? `${done.data.length}` : undefined} />
      <div className="view-body">
        <div className="view-inner view-inner-narrow">
          {stats.data && <StatsPanel stats={stats.data} />}
          {(done.isLoading || stats.isLoading) && <ListSkeleton />}
          {done.isError && <ErrorState message={errorMessage(done.error)} onRetry={() => void done.refetch()} />}
          {done.data && done.data.length === 0 && <Empty icon={<CheckCircle2 />} title={t("completed.empty.title")} body={t("completed.empty.body")} />}
          {groups.map(([day, tasks]) => (
            <section key={day} className="group">
              <div className="group-head">
                {day === "unknown" ? "—" : relativeDay(day, now.date, lang, t)}
                <span className="count">{tasks.length}</span>
              </div>
              <div className="task-list">
                {tasks.map((task) => {
                  const project = task.projectId ? projectById.get(task.projectId) : undefined;
                  const over = task.actualMin !== null && task.actualMin > task.estimateMin * 1.2;
                  return (
                    <div key={task.id} className="task-row is-done completed-row">
                      <CheckCircle2 className="completed-icon" />
                      <div className="task-main">
                        <button type="button" className="task-title" onClick={() => ui.set({ editingTaskId: task.id })}>
                          {task.title}
                        </button>
                        <div className="task-meta">
                          <span className="meta-item">
                            <PriorityIcon priority={task.priority} size={12} />
                          </span>
                          <span className={`meta-item tnum ${over ? "meta-warning" : ""}`}>
                            {t("completed.estimateVsActual", { est: formatDuration(task.estimateMin), act: task.actualMin ? formatDuration(task.actualMin) : "–" })}
                          </span>
                          {project && (
                            <span className="meta-item">
                              <span className="dot" style={{ background: project.color, width: 7, height: 7 }} />
                              {project.name}
                            </span>
                          )}
                          {task.completedAt && (
                            <span className="meta-item tnum">
                              {new Intl.DateTimeFormat(lang === "fr" ? "fr-FR" : "en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz }).format(new Date(task.completedAt))}
                            </span>
                          )}
                        </div>
                      </div>
                      <IconButton size="sm" label={t("action.reopen")} onClick={() => void run(() => api.reopenTask(task.id), { success: t("toast.reopened", { title: task.title }), undoLabel: t("common.undo") })}>
                        <RotateCcw />
                      </IconButton>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
    </>
  );
}

export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="stack" style={{ gap: 10 }} aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: 40, opacity: 1 - i * 0.14 }} />
      ))}
    </div>
  );
}

function StatsPanel({ stats }: { stats: StatsSummary }) {
  const t = useT();
  return (
    <section className="stats-panel card">
      <div className="stat-tiles">
        <div className="stat-tile">
          <span className="stat-label">{t("completed.tasksDone")}</span>
          <span className="stat-value tnum">{stats.completedThisWeek}</span>
          <span className="stat-hint">{t("completed.thisWeek")}</span>
        </div>
        <div className="stat-tile">
          <span className="stat-label">{t("completed.focus")}</span>
          <span className="stat-value tnum">{formatDuration(stats.focusMinutesThisWeek)}</span>
          <span className="stat-hint">{t("completed.thisWeek")}</span>
        </div>
        <div className="stat-tile">
          <span className="stat-label">{t("completed.accuracy")}</span>
          <span className="stat-value tnum">{stats.estimateAccuracy === null ? "–" : `${stats.estimateAccuracy}%`}</span>
          <span className="stat-hint">&nbsp;</span>
        </div>
        <div className="stat-tile">
          <span className="stat-label">{t("completed.streak")}</span>
          <span className="stat-value tnum">{stats.streak}</span>
          <span className="stat-hint">{t(stats.streak === 1 ? "completed.day" : "completed.days", { n: stats.streak })}</span>
        </div>
      </div>
      <CompletionChart days={stats.days} />
    </section>
  );
}

/** Single-series column chart: tasks completed per day. Hover for details; a table backs it for screen readers. */
function CompletionChart({ days }: { days: StatsSummary["days"] }) {
  const t = useT();
  const lang = useLang();
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...days.map((d) => d.completed));
  const top = Math.max(2, Math.ceil(max / 2) * 2);
  const H = 120;
  const peak = days.reduce((best, d, i) => (d.completed > (days[best]?.completed ?? -1) ? i : best), 0);
  const ticks = [0, top / 2, top];
  return (
    <figure className="chart">
      <figcaption className="chart-title">{t("completed.chartLabel")}</figcaption>
      <div className="chart-plot" onMouseLeave={() => setHover(null)}>
        <div className="chart-y">
          {ticks.map((v) => (
            <span key={v} className="tnum" style={{ bottom: (v / top) * H - 6 }}>
              {v}
            </span>
          ))}
        </div>
        <div className="chart-area" style={{ height: H }}>
          {ticks.map((v) => (
            <div key={v} className="chart-grid" style={{ bottom: (v / top) * H }} />
          ))}
          <div className="chart-cols" style={{ gridTemplateColumns: `repeat(${days.length}, 1fr)` }}>
            {days.map((d, i) => {
              const h = (d.completed / top) * H;
              const showLabel = d.completed > 0 && (i === peak || i === days.length - 1);
              return (
                <div key={d.date} className={`chart-col ${hover === i ? "is-hover" : ""}`} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0} aria-label={`${d.date}: ${d.completed}`}>
                  {showLabel && (
                    <span className="chart-value tnum" style={{ bottom: h + 4 }}>
                      {d.completed}
                    </span>
                  )}
                  <span className="chart-bar" style={{ height: Math.max(d.completed > 0 ? 3 : 0, h) }} />
                </div>
              );
            })}
          </div>
          {hover !== null && days[hover] && (
            <div className="chart-tip" style={{ left: `${((hover + 0.5) / days.length) * 100}%` }} role="status">
              <strong>{fmtDate(days[hover]!.date, lang, { weekday: "short", day: "numeric", month: "short" })}</strong>
              <span className="tnum">
                {days[hover]!.completed} · {formatDuration(days[hover]!.actualMin || days[hover]!.plannedMin)}
              </span>
              {days[hover]!.focusMin > 0 && <span className="tnum faint">{t("completed.focus")}: {formatDuration(days[hover]!.focusMin)}</span>}
            </div>
          )}
        </div>
        <div className="chart-x" style={{ gridTemplateColumns: `repeat(${days.length}, 1fr)` }}>
          {days.map((d, i) => (
            <span key={d.date} className="tnum">
              {i % 2 === days.length % 2 || i === days.length - 1 ? fmtDate(d.date, lang, { day: "numeric" }) : ""}
            </span>
          ))}
        </div>
      </div>
      <table className="sr-only">
        <caption>{t("completed.chartLabel")}</caption>
        <tbody>
          {days.map((d) => (
            <tr key={d.date}>
              <th scope="row">{d.date}</th>
              <td>{d.completed}</td>
              <td>{d.focusMin} min</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
