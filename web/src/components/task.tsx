import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  CalendarClock,
  CalendarX2,
  Check,
  Clock,
  CornerDownRight,
  Crosshair,
  Flag,
  Inbox,
  Link2,
  ListChecks,
  Lock,
  MoreHorizontal,
  Pencil,
  Pin,
  Play,
  Repeat,
  Sparkles,
  SunMedium,
  Trash2,
} from "lucide-react";
import { memo, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { Project, Task } from "@shared/schemas";
import { addDays, formatDuration, type ZonedNow } from "@shared/time";
import { api } from "../lib/api";
import { deadlineLabel, relativeDay, timeRange } from "../lib/format";
import { useLang, useT } from "../lib/i18n";
import { invalidatePlanning, useAction } from "../lib/queries";
import { useUi } from "../lib/store";
import { patchTaskInCaches, taskState, type TaskState } from "../lib/tasks";
import { toast } from "../lib/toast";
import { Badge, confirmAction, Menu, type MenuEntry } from "./ui";

// ---------------------------------------------------------------------------
// Priority indicator
// ---------------------------------------------------------------------------

export function PriorityIcon({ priority, size = 14 }: { priority: Task["priority"]; size?: number }) {
  const t = useT();
  const label = t(`priority.${priority}`);
  if (priority === "critical") {
    return (
      <svg className="prio prio-critical" width={size} height={size} viewBox="0 0 16 16" role="img" aria-label={label}>
        <title>{label}</title>
        <rect x="1" y="1" width="14" height="14" rx="3.5" fill="currentColor" />
        <rect x="7.1" y="4" width="1.8" height="5.2" rx="0.9" fill="var(--bg-elev)" />
        <rect x="7.1" y="10.4" width="1.8" height="1.8" rx="0.9" fill="var(--bg-elev)" />
      </svg>
    );
  }
  const filled = priority === "high" ? 3 : priority === "medium" ? 2 : 1;
  return (
    <svg className={`prio prio-${priority}`} width={size} height={size} viewBox="0 0 16 16" role="img" aria-label={label}>
      <title>{label}</title>
      {[0, 1, 2].map((i) => (
        <rect key={i} x={2 + i * 4.6} y={10 - i * 3} width="2.8" height={4 + i * 3} rx="1" fill="currentColor" opacity={i < filled ? 1 : 0.22} />
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Checkbox
// ---------------------------------------------------------------------------

export function TaskCheckbox({
  task,
  onToggle,
  size = 17,
}: {
  task: Task;
  onToggle: () => void;
  size?: number;
}) {
  const t = useT();
  const done = task.status === "done";
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      aria-label={done ? t("action.reopen") : t("action.complete")}
      className={`task-check prio-ring-${task.priority} ${done ? "is-checked" : ""}`}
      style={{ width: size, height: size } as CSSProperties}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      {done && <Check strokeWidth={3} />}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Actions shared by every place a task appears
// ---------------------------------------------------------------------------

export function useTaskActions() {
  const t = useT();
  const qc = useQueryClient();
  const run = useAction();
  const ui = useUi();
  return {
    async toggle(task: Task, today: string) {
      const done = task.status === "done";
      patchTaskInCaches(qc, task.id, done ? { status: "todo", completedAt: null } : { status: "done", completedAt: new Date().toISOString() });
      void today;
      await run(() => (done ? api.reopenTask(task.id) : api.completeTask(task.id)), {
        success: t(done ? "toast.reopened" : "toast.completed", { title: task.title }),
        undoLabel: t("common.undo"),
      });
    },
    postpone: (task: Task, today: string) =>
      run(() => api.moveTask(task.id, addDays(task.plannedDate && task.plannedDate > today ? task.plannedDate : today, 1)), {
        success: t("toast.moved", { when: t("common.tomorrow").toLowerCase() }),
        undoLabel: t("common.undo"),
      }),
    moveToday: (task: Task, today: string) => run(() => api.moveTask(task.id, today), { success: t("toast.moved", { when: t("common.today").toLowerCase() }), undoLabel: t("common.undo") }),
    unschedule: (task: Task) => run(() => api.unscheduleTask(task.id), { success: t("toast.saved"), undoLabel: t("common.undo") }),
    toBacklog: (task: Task) => run(() => api.unscheduleTask(task.id, true), { success: t("toast.saved"), undoLabel: t("common.undo") }),
    start: (task: Task) => run(() => api.startTask(task.id), { silent: true }),
    focus: (task: Task) => ui.set({ focusTaskId: task.id }),
    edit: (task: Task) => ui.set({ editingTaskId: task.id }),
    schedule: (task: Task) => ui.set({ scheduling: { taskId: task.id, mode: "schedule" } }),
    moveTo: (task: Task) => ui.set({ scheduling: { taskId: task.id, mode: "move" } }),
    async remove(task: Task) {
      const series = task.recurrence !== null && task.recurrenceParentId === null;
      const { ok } = await confirmAction({
        title: series ? t("action.deleteSeries") : t("action.deleteConfirm", { title: task.title }),
        body: t("action.deleteBody"),
        confirmLabel: t("common.delete"),
        cancelLabel: t("common.cancel"),
        danger: true,
      });
      if (!ok) return;
      await run(() => api.deleteTask(task.id), { success: t("toast.deleted", { title: task.title }), undoLabel: t("common.undo") });
    },
    async rename(task: Task, title: string) {
      const clean = title.trim();
      if (!clean || clean === task.title) return;
      patchTaskInCaches(qc, task.id, { title: clean });
      await run(() => api.updateTask(task.id, { title: clean }), { silent: true });
    },
    refresh: () => invalidatePlanning(qc),
  };
}

export function taskMenu(task: Task, today: string, a: ReturnType<typeof useTaskActions>, t: ReturnType<typeof useT>): MenuEntry[] {
  const done = task.status === "done";
  const isSeries = task.recurrence !== null && task.recurrenceParentId === null;
  return [
    { label: t("action.focus"), icon: <Crosshair />, onSelect: () => a.focus(task), hidden: done || isSeries, kbd: "F" },
    { label: t("action.start"), icon: <Play />, onSelect: () => void a.start(task), hidden: done || isSeries || task.status === "in_progress" },
    { label: t("common.edit"), icon: <Pencil />, onSelect: () => a.edit(task), kbd: "E" },
    "sep",
    { label: t("action.schedule"), icon: <CalendarClock />, onSelect: () => a.schedule(task), hidden: done || isSeries },
    { label: t("action.moveToday"), icon: <SunMedium />, onSelect: () => void a.moveToday(task, today), hidden: done || isSeries || task.plannedDate === today },
    { label: t("action.postponeTomorrow"), icon: <ArrowRight />, onSelect: () => void a.postpone(task, today), hidden: done || isSeries },
    { label: t("action.moveTo"), icon: <CornerDownRight />, onSelect: () => a.moveTo(task), hidden: done || isSeries },
    { label: t("action.unschedule"), icon: <CalendarX2 />, onSelect: () => void a.unschedule(task), hidden: done || !task.scheduledStart },
    { label: t("action.toBacklog"), icon: <Inbox />, onSelect: () => void a.toBacklog(task), hidden: done || isSeries || !task.plannedDate },
    "sep",
    { label: t("action.delete"), icon: <Trash2 />, onSelect: () => void a.remove(task), danger: true },
  ];
}

// ---------------------------------------------------------------------------
// Task row
// ---------------------------------------------------------------------------

export interface RowContext {
  now: ZonedNow;
  projects: Map<string, Project>;
  statusById: Map<string, Task["status"]>;
  titles: Map<string, string>;
}

function StateBadges({ s, task }: { s: TaskState; task: Task }) {
  const t = useT();
  const out: ReactNode[] = [];
  if (s.now && !s.done) out.push(<Badge key="now" tone="accent" dot>{t("state.now")}</Badge>);
  else if (s.inProgress) out.push(<Badge key="ip" tone="accent" dot>{t("state.inProgress")}</Badge>);
  if (s.missed && !s.overdue) out.push(<Badge key="missed" tone="warning">{t("state.missed")}</Badge>);
  if (s.blocked) out.push(<Badge key="blocked" tone="outline"><Lock />{t("state.blocked")}</Badge>);
  void task;
  return <>{out}</>;
}

export const TaskRow = memo(function TaskRow({
  task,
  ctx,
  showDate,
  showTime = true,
  dragHandle,
  onOpen,
  extra,
}: {
  task: Task;
  ctx: RowContext;
  showDate?: boolean;
  showTime?: boolean;
  dragHandle?: ReactNode;
  onOpen?: () => void;
  extra?: ReactNode;
}) {
  const t = useT();
  const lang = useLang();
  const a = useTaskActions();
  const s = taskState(task, ctx.now, ctx.statusById);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => setDraft(task.title), [task.title]);
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const project = task.projectId ? ctx.projects.get(task.projectId) : undefined;
  const range = timeRange(task);
  const deadline = task.dueAt && !s.done ? deadlineLabel(task.dueAt, ctx.now.dateTime, ctx.now.date, lang, t) : null;
  const subDone = task.subtasks.filter((x) => x.done).length;
  const waitsFor = task.dependsOn.map((d) => ctx.titles.get(d)).filter(Boolean);

  const classes = ["task-row", s.done ? "is-done" : "", s.overdue ? "is-overdue" : "", s.missed ? "is-missed" : "", s.now ? "is-now" : ""].filter(Boolean).join(" ");

  return (
    <div
      className={classes}
      data-task-id={task.id}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest(".task-title")) return;
        (onOpen ?? (() => a.edit(task)))();
      }}
    >
      {dragHandle}
      <TaskCheckbox task={task} onToggle={() => void a.toggle(task, ctx.now.date)} />
      <div className="task-main">
        <div className="task-line">
          {editing ? (
            <input
              ref={inputRef}
              className="task-title-input"
              value={draft}
              aria-label={t("task.title")}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => {
                setEditing(false);
                void a.rename(task, draft);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") {
                  setDraft(task.title);
                  setEditing(false);
                }
              }}
            />
          ) : (
            <button
              type="button"
              className="task-title"
              onClick={() => (onOpen ?? (() => a.edit(task)))()}
              onDoubleClick={(e) => {
                e.stopPropagation();
                if (!s.done) setEditing(true);
              }}
              title={task.title}
            >
              {task.title}
            </button>
          )}
          <StateBadges s={s} task={task} />
        </div>
        <div className="task-meta">
          <span className="meta-item meta-prio">
            <PriorityIcon priority={task.priority} size={12} />
          </span>
          {showTime &&
            (range ? (
              <span className="meta-item tnum">
                {task.pinned ? <Pin className="meta-pin" /> : <Clock />}
                {range}
              </span>
            ) : null)}
          {showDate && task.plannedDate && <span className="meta-item">{relativeDay(task.plannedDate, ctx.now.date, lang, t)}</span>}
          <span className="meta-item tnum">{formatDuration(task.estimateMin)}</span>
          {project && (
            <span className="meta-item">
              <span className="dot" style={{ background: project.color, width: 7, height: 7 }} />
              <span className="truncate">{project.name}</span>
            </span>
          )}
          {deadline && (
            <span className={`meta-item meta-${deadline.tone}`}>
              <Flag />
              {deadline.text}
            </span>
          )}
          {task.subtasks.length > 0 && (
            <span className="meta-item tnum">
              <ListChecks />
              {subDone}/{task.subtasks.length}
            </span>
          )}
          {waitsFor.length > 0 && (
            <span className="meta-item" title={`${t("task.dependencies")}: ${waitsFor.join(", ")}`}>
              <Link2 />
              <span className="truncate">{waitsFor[0]}</span>
            </span>
          )}
          {task.source === "ai" && (
            <span className="meta-item meta-ai" title={t("task.addedByAura")}>
              <Sparkles />
            </span>
          )}
          {(task.recurrenceParentId || task.recurrence) && (
            <span className="meta-item" title={t("state.recurring")}>
              <Repeat />
            </span>
          )}
          {task.tags.slice(0, 2).map((tag) => (
            <span key={tag} className="meta-item meta-tag">
              #{tag}
            </span>
          ))}
        </div>
      </div>
      {extra}
      <div className="task-actions">
        <Menu
          label={t("common.more")}
          align="end"
          items={taskMenu(task, ctx.now.date, a, t)}
          trigger={(p) => (
            <button type="button" className="icon-btn icon-btn-sm" aria-label={t("common.more")} {...p}>
              <MoreHorizontal />
            </button>
          )}
        />
      </div>
    </div>
  );
});

export function useRowContext(tasks: Task[], projects: Project[] | undefined, now: ZonedNow, allTasks?: Task[]): RowContext {
  const source = allTasks ?? tasks;
  return {
    now,
    projects: new Map((projects ?? []).map((p) => [p.id, p])),
    statusById: new Map(source.map((x) => [x.id, x.status])),
    titles: new Map(source.map((x) => [x.id, x.title])),
  };
}

export function notifyError(message: string) {
  toast.error(message);
}
