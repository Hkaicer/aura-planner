import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  AlertTriangle,
  ArrowDownToLine,
  CalendarCheck2,
  ChevronDown,
  Flame,
  GripVertical,
  LayoutList,
  ListOrdered,
  Moon,
  Plus,
  RefreshCw,
  Rows3,
  Sparkles,
  Sunrise,
  Wand2,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { DayView, Proposal } from "@shared/api";
import type { Task } from "@shared/schemas";
import { formatDuration, timeOf } from "@shared/time";
import { DayTimeline } from "../components/DayTimeline";
import { ProposalView } from "../components/ProposalView";
import { TaskRow, useRowContext, type RowContext } from "../components/task";
import { Badge, Button, Dialog, Empty, ErrorState, IconButton, Menu, Segmented, Spinner } from "../components/ui";
import { ViewHeader } from "../components/ViewHeader";
import { api } from "../lib/api";
import { greetingKey, longDay, modelLabel, relativeTime } from "../lib/format";
import { useLang, useT, type Key } from "../lib/i18n";
import { errorMessage, useAction, useAiStatus, useBootstrap, useDay, useNow, useProjects, useTasks } from "../lib/queries";
import { useUi, type TodayMode } from "../lib/store";
import { PRIORITY_ORDER } from "../lib/tasks";
import { toast } from "../lib/toast";
import { useQueryClient } from "@tanstack/react-query";

export function TodayView() {
  const t = useT();
  const lang = useLang();
  const ui = useUi();
  const now = useNow();
  const day = useDay(now.date);
  const projects = useProjects();
  const allTasks = useTasks("all");
  const boot = useBootstrap();
  const [planProposal, setPlanProposal] = useState<Proposal | null>(null);
  const [planning, setPlanning] = useState(false);

  const plan = async (mode: "full" | "preserve" | "reflow", intensity?: "normal" | "light") => {
    setPlanning(true);
    try {
      setPlanProposal(await api.plan(now.date, mode, intensity));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPlanning(false);
    }
  };

  const ctx = useRowContext(day.data?.tasks ?? [], projects.data, now, allTasks.data);
  const name = boot.data?.settings.displayName;
  const evening = now.minutes >= 17 * 60;

  return (
    <>
      <ViewHeader
        title={t("nav.today")}
        sub={longDay(now.date, lang)}
        actions={
          <>
            <Button variant="ghost" icon={evening ? <Moon /> : <Sunrise />} onClick={() => ui.set({ dialog: evening ? "evening" : "morning" })}>
              <span className="hide-sm">{evening ? t("today.evening") : t("today.morning")}</span>
            </Button>
            <div className="split-btn">
              <Button
                icon={planning ? <Spinner /> : <Wand2 />}
                onClick={() => void plan(day.data?.plan.acceptedAt ? "preserve" : "full")}
                disabled={planning}
                aria-label={day.data?.plan.acceptedAt ? t("today.replan") : t("today.planDay")}
              >
                <span className="hide-xs">{day.data?.plan.acceptedAt ? t("today.replan") : t("today.planDay")}</span>
              </Button>
              <Menu
                label={t("today.planDay")}
                align="end"
                items={[
                  { label: t("today.plan.full"), icon: <Wand2 />, onSelect: () => void plan("full") },
                  { label: t("today.plan.preserve"), icon: <CalendarCheck2 />, onSelect: () => void plan("preserve") },
                  { label: t("today.plan.reflow"), icon: <ArrowDownToLine />, onSelect: () => void plan("reflow") },
                  { label: t("today.lightDay"), icon: <Moon />, onSelect: () => void plan("full", "light") },
                ]}
                trigger={(p) => (
                  <button type="button" className="btn split-btn-caret" aria-label={t("common.more")} {...p}>
                    <ChevronDown />
                  </button>
                )}
              />
            </div>
            <Segmented<TodayMode>
              label={t("today.view.timeline")}
              value={ui.todayMode}
              onChange={(v) => ui.set({ todayMode: v })}
              options={[
                { value: "timeline", label: "", icon: <Rows3 aria-hidden />, ariaLabel: `${t("today.view.timeline")} (1)` },
                { value: "list", label: "", icon: <LayoutList aria-hidden />, ariaLabel: `${t("today.view.list")} (2)` },
                { value: "priority", label: "", icon: <ListOrdered aria-hidden />, ariaLabel: `${t("today.view.priority")} (3)` },
              ]}
            />
          </>
        }
      />
      <div className="view-body">
        <div className="view-inner today">
          {day.isLoading && <TodaySkeleton />}
          {day.isError && <ErrorState message={errorMessage(day.error)} onRetry={() => void day.refetch()} retryLabel={t("common.retry")} />}
          {day.data && (
            <>
              <section className="today-hero">
                <h1 className="today-greeting">
                  {t(greetingKey(now.minutes))}
                  {name ? `, ${name}` : ""}
                </h1>
                <Brief view={day.data} />
              </section>
              <DayStats view={day.data} />
              <Conflicts view={day.data} />
              {day.data.overdue.length > 0 && <Overdue tasks={day.data.overdue} ctx={ctx} today={now.date} />}
              <DayContent view={day.data} ctx={ctx} mode={ui.todayMode} />
            </>
          )}
        </div>
      </div>
      <Dialog open={planProposal !== null} onClose={() => setPlanProposal(null)} title={t("proposal.engineTitle")} size="lg" labelledBy="plan-title">
        <div className="dialog-body">{planProposal && <ProposalView proposal={planProposal} onResolved={() => setPlanProposal(null)} />}</div>
      </Dialog>
    </>
  );
}

function TodaySkeleton() {
  return (
    <div className="stack" style={{ gap: 16 }} aria-busy="true">
      <div className="skeleton" style={{ height: 30, width: 260 }} />
      <div className="skeleton" style={{ height: 18, width: "60%" }} />
      <div className="stats-row">
        {[0, 1, 2].map((i) => (
          <div key={i} className="skeleton" style={{ height: 84, borderRadius: 12 }} />
        ))}
      </div>
      <div className="skeleton" style={{ height: 360, borderRadius: 12 }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI brief (cached on the day) with a deterministic fallback summary
// ---------------------------------------------------------------------------

function Brief({ view }: { view: DayView }) {
  const t = useT();
  const lang = useLang();
  const ai = useAiStatus();
  const qc = useQueryClient();
  const [loading, setLoading] = useState(false);
  const open = view.tasks.filter((x) => x.status !== "done" && x.status !== "cancelled");
  const next = open.filter((x) => x.scheduledStart && x.scheduledStart > view.now).sort((a, b) => a.scheduledStart!.localeCompare(b.scheduledStart!))[0];
  const dueToday = open.filter((x) => x.dueAt && x.dueAt.slice(0, 10) === view.date).length;
  const computed = [
    t("today.computedSummary", { remaining: open.length, done: view.progress.done }),
    next ? t("today.nextUp", { title: next.title, time: timeOf(next.scheduledStart!) }) : "",
    dueToday ? t("today.dueToday", { n: dueToday }) : "",
  ]
    .filter(Boolean)
    .join(" ");
  const ready = ai.data?.state === "ready";
  const brief = view.plan.aiBrief;
  const request = async () => {
    setLoading(true);
    try {
      await api.brief(view.date);
      await qc.invalidateQueries({ queryKey: ["day", view.date] });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="brief">
      {brief ? (
        <>
          <p className="brief-text">
            <Sparkles className="brief-icon" />
            {brief.text}
          </p>
          <div className="brief-meta">
            <span>{t("today.briefBy", { model: modelLabel(brief.model), time: relativeTime(brief.createdAt, lang) })}</span>
            <IconButton size="sm" label={t("today.briefRefresh")} onClick={() => void request()} disabled={!ready || loading}>
              {loading ? <Spinner /> : <RefreshCw />}
            </IconButton>
          </div>
        </>
      ) : (
        <div className="brief-row">
          <p className="brief-text brief-computed">{computed}</p>
          <Button
            size="sm"
            variant="ghost"
            icon={loading ? <Spinner /> : <Sparkles />}
            onClick={() => void request()}
            disabled={!ready || loading}
            title={ready ? undefined : t("today.briefUnavailable")}
            className="brief-btn"
          >
            {t("today.brief")}
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

function DayStats({ view }: { view: DayView }) {
  const t = useT();
  const a = view.analysis;
  const p = view.progress;
  const statusTone = a.status === "overloaded" ? "danger" : a.status === "tight" ? "warning" : a.status === "ok" ? "success" : "neutral";
  const hint =
    a.status === "overloaded"
      ? t("day.status.overloadedHint", { over: formatDuration(a.overloadMin) })
      : a.status === "tight"
        ? t("day.status.tightHint")
        : a.status === "empty"
          ? t("day.status.emptyHint")
          : t("day.status.okHint");
  const load = a.availableMin > 0 ? Math.min(1, a.remainingDemandMin / a.availableMin) : a.remainingDemandMin > 0 ? 1 : 0;
  return (
    <div className="stats-row">
      <div className="stat">
        <div className="stat-label">{t("today.completed")}</div>
        <div className="stat-value tnum">
          {p.done}
          <span className="stat-of">/{p.total}</span>
          <span className="stat-pct">{p.pct}%</span>
        </div>
        <div className={`progress ${p.pct === 100 ? "is-success" : ""}`}>
          <span style={{ width: `${p.pct}%` }} />
        </div>
      </div>
      <div className="stat">
        <div className="stat-label">
          {t("today.planned")} / {t("today.available").toLowerCase()}
        </div>
        <div className="stat-value tnum">
          {formatDuration(a.remainingDemandMin)}
          <span className="stat-of"> / {formatDuration(a.availableMin)}</span>
        </div>
        <div className={`progress load-${statusTone}`}>
          <span style={{ width: `${Math.round(load * 100)}%` }} />
        </div>
      </div>
      <div className={`stat stat-status tone-${statusTone}`}>
        <div className="stat-label">{t("today.window", { start: view.window.start, end: view.window.end })}</div>
        <div className="stat-value">
          <Badge tone={statusTone === "neutral" ? "neutral" : statusTone} dot>
            {t(`day.status.${a.status}` as Key)}
          </Badge>
          {view.plan.intensity === "light" && <Badge tone="outline">{t("today.lightDay")}</Badge>}
          {view.streak > 1 && (
            <span className="stat-streak" title={t("today.streak", { n: view.streak })}>
              <Flame />
              {view.streak}
            </span>
          )}
        </div>
        <div className="stat-hint">{hint}</div>
      </div>
    </div>
  );
}

function Conflicts({ view }: { view: DayView }) {
  const t = useT();
  const relevant = view.analysis.conflicts.filter((c) => c.kind !== "missed");
  if (relevant.length === 0) return null;
  return (
    <div className="callout callout-warning conflicts" role="status">
      <AlertTriangle />
      <div>
        {relevant.slice(0, 4).map((c, i) => (
          <div key={i}>{c.message}</div>
        ))}
      </div>
      <span className="spacer" />
      <Button size="sm" onClick={() => useUi.getState().askAssistant(t("assistant.suggest.plan"), false)}>
        <Sparkles />
        {t("nav.ask")}
      </Button>
    </div>
  );
}

function Overdue({ tasks, ctx, today }: { tasks: Task[]; ctx: RowContext; today: string }) {
  const t = useT();
  const run = useAction();
  return (
    <section className="group overdue-group">
      <div className="group-head">
        <AlertTriangle className="tone-warning-icon" />
        {t("today.overdueSection")}
        <span className="count">{tasks.length}</span>
        <span className="spacer" />
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void run(() => api.postpone(tasks.map((x) => x.id), today), { success: t("toast.moved", { when: t("common.today").toLowerCase() }), undoLabel: t("common.undo") })
          }
        >
          {t("today.moveAllToday")}
        </Button>
      </div>
      <div className="task-list card-list">
        {tasks.map((task) => (
          <TaskRow key={task.id} task={task} ctx={ctx} showDate />
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Content modes
// ---------------------------------------------------------------------------

function DayContent({ view, ctx, mode }: { view: DayView; ctx: RowContext; mode: TodayMode }) {
  const t = useT();
  const ui = useUi();
  const hasContent = view.tasks.length > 0 || view.events.length > 0;
  if (!hasContent) {
    return (
      <div className="card today-empty">
        <Empty icon={<Sunrise />} title={t("today.empty.title")} body={t("today.empty.body")}>
          <Button onClick={() => ui.set({ quickAdd: { plannedDate: view.date } })}>{t("today.empty.add")}</Button>
          <Button variant="primary" icon={<Sparkles />} onClick={() => ui.askAssistant("")}>
            {t("today.empty.ask")}
          </Button>
        </Empty>
      </div>
    );
  }
  if (mode === "timeline") return <TimelineMode view={view} ctx={ctx} />;
  if (mode === "priority") return <PriorityMode view={view} ctx={ctx} />;
  return <ListMode view={view} ctx={ctx} />;
}

function splitTasks(view: DayView) {
  const open = view.tasks.filter((x) => x.status !== "done" && x.status !== "cancelled");
  const done = view.tasks.filter((x) => x.status === "done");
  const scheduled = open.filter((x) => x.scheduledStart).sort((a, b) => a.scheduledStart!.localeCompare(b.scheduledStart!));
  const flexible = open.filter((x) => !x.scheduledStart).sort((a, b) => a.position - b.position);
  return { open, done, scheduled, flexible };
}

function TimelineMode({ view, ctx }: { view: DayView; ctx: RowContext }) {
  const t = useT();
  const ui = useUi();
  const { flexible, done } = splitTasks(view);
  const [showDone, setShowDone] = useState(false);
  return (
    <div className="today-split">
      <div className="card tl-card">
        <DayTimeline view={view} ctx={ctx} conflicts={view.analysis.conflicts} />
      </div>
      <aside className="flex-panel">
        <div className="group-head">
          {t("today.flexible")}
          <span className="count">{flexible.length}</span>
          <span className="spacer" />
          <IconButton size="sm" label={t("nav.newTask")} onClick={() => ui.set({ quickAdd: { plannedDate: view.date } })}>
            <Plus />
          </IconButton>
        </div>
        {flexible.length === 0 ? (
          <p className="flex-hint">{t("today.flexibleHint")}</p>
        ) : (
          <div className="task-list">
            {flexible.map((task) => (
              <div
                key={task.id}
                draggable
                className="draggable-row"
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/aura-task", task.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
              >
                <TaskRow task={task} ctx={ctx} showTime={false} />
              </div>
            ))}
          </div>
        )}
        {done.length > 0 && (
          <div className="done-block">
            <button type="button" className="group-head group-toggle" onClick={() => setShowDone((s) => !s)} aria-expanded={showDone}>
              <ChevronDown className={showDone ? "" : "is-collapsed"} />
              {t("today.doneSection")}
              <span className="count">{done.length}</span>
            </button>
            {showDone && (
              <div className="task-list">
                {done.map((task) => (
                  <TaskRow key={task.id} task={task} ctx={ctx} />
                ))}
              </div>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

function SortableRow({ task, ctx }: { task: Task; ctx: RowContext }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 2 : undefined, position: "relative" }} className={isDragging ? "is-sorting" : ""}>
      <TaskRow
        task={task}
        ctx={ctx}
        showTime={false}
        dragHandle={
          <button type="button" className="drag-handle" aria-label="Reorder" {...attributes} {...listeners}>
            <GripVertical />
          </button>
        }
      />
    </div>
  );
}

function ListMode({ view, ctx }: { view: DayView; ctx: RowContext }) {
  const t = useT();
  const run = useAction();
  const { scheduled, flexible, done } = splitTasks(view);
  const [order, setOrder] = useState<string[] | null>(null);
  const ids = order && order.length === flexible.length && flexible.every((f) => order.includes(f.id)) ? order : flexible.map((f) => f.id);
  const byId = new Map(flexible.map((f) => [f.id, f]));
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const next = arrayMove(ids, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id)));
    setOrder(next);
    void run(() => api.reorder(next), { silent: true });
  };
  return (
    <div className="list-mode">
      {scheduled.length > 0 && (
        <section className="group">
          <div className="group-head">
            {t("today.scheduled")}
            <span className="count">{scheduled.length}</span>
          </div>
          <div className="task-list">
            {scheduled.map((task) => (
              <TaskRow key={task.id} task={task} ctx={ctx} />
            ))}
          </div>
        </section>
      )}
      {flexible.length > 0 && (
        <section className="group">
          <div className="group-head">
            {t("today.flexible")}
            <span className="count">{flexible.length}</span>
          </div>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
              <div className="task-list">
                {ids.map((id) => {
                  const task = byId.get(id);
                  return task ? <SortableRow key={id} task={task} ctx={ctx} /> : null;
                })}
              </div>
            </SortableContext>
          </DndContext>
        </section>
      )}
      {done.length > 0 && (
        <section className="group">
          <div className="group-head">
            {t("today.doneSection")}
            <span className="count">{done.length}</span>
          </div>
          <div className="task-list">
            {done.map((task) => (
              <TaskRow key={task.id} task={task} ctx={ctx} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function PriorityMode({ view, ctx }: { view: DayView; ctx: RowContext }) {
  const t = useT();
  const groups = useMemo(() => {
    const open = view.tasks.filter((x) => x.status !== "done" && x.status !== "cancelled");
    return PRIORITY_ORDER.map((p) => ({
      p,
      tasks: open
        .filter((x) => x.priority === p)
        .sort((a, b) => (view.scores[b.id]?.total ?? 0) - (view.scores[a.id]?.total ?? 0)),
    })).filter((g) => g.tasks.length > 0);
  }, [view]);
  const done = view.tasks.filter((x) => x.status === "done");
  return (
    <div className="list-mode">
      {groups.map((g) => (
        <section key={g.p} className="group">
          <div className="group-head">
            {t(`priority.${g.p}`)}
            <span className="count">{g.tasks.length}</span>
          </div>
          <div className="task-list">
            {g.tasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                ctx={ctx}
                extra={<ScoreChip score={view.scores[task.id]?.total ?? 0} parts={view.scores[task.id]?.parts ?? []} />}
              />
            ))}
          </div>
        </section>
      ))}
      {done.length > 0 && (
        <section className="group">
          <div className="group-head">
            {t("today.doneSection")}
            <span className="count">{done.length}</span>
          </div>
          <div className="task-list">
            {done.map((task) => (
              <TaskRow key={task.id} task={task} ctx={ctx} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

const SCORE_LABEL: Record<string, { en: string; fr: string }> = {
  priority: { en: "Priority", fr: "Priorité" },
  deadline: { en: "Deadline", fr: "Échéance" },
  overdue: { en: "Overdue", fr: "En retard" },
  postponed: { en: "Postponed", fr: "Reportée" },
  project_deadline: { en: "Project deadline", fr: "Échéance du projet" },
};

export function ScoreChip({ score, parts }: { score: number; parts: { key: string; value: number }[] }) {
  const lang = useLang();
  const detail = parts.map((p) => `${SCORE_LABEL[p.key]?.[lang] ?? p.key} +${p.value}`).join(" · ");
  return (
    <span className="score-chip tnum" title={detail} aria-label={`Score ${score}: ${detail}`}>
      {score}
    </span>
  );
}
