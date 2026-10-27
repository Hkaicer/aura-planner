import { useQuery } from "@tanstack/react-query";
import { Check, Link2, Plus, Repeat, RotateCcw, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Recurrence, Subtask, Task, TaskPatch } from "@shared/schemas";
import { combine, dateOf, timeOf } from "@shared/time";
import { api } from "../lib/api";
import { relativeTime } from "../lib/format";
import { useLang, useT, type Key } from "../lib/i18n";
import { useAction, useProjects, useTasks } from "../lib/queries";
import { useUi } from "../lib/store";
import { PRIORITY_ORDER } from "../lib/tasks";
import { PriorityIcon, useTaskActions } from "./task";
import { Button, Dialog, Field, Spinner, Switch } from "./ui";

const ESTIMATES = [5, 10, 15, 20, 30, 45, 60, 75, 90, 120, 150, 180, 240];

let tempId = 0;
const newSubtaskId = () => `s_new${++tempId}${Date.now().toString(36).slice(-4)}`;

interface Draft {
  title: string;
  description: string;
  priority: Task["priority"];
  estimateMin: number;
  energy: Task["energy"];
  plannedDate: string;
  start: string;
  pinned: boolean;
  dueDate: string;
  dueTime: string;
  dueHard: boolean;
  startDate: string;
  projectId: string;
  category: string;
  tags: string;
  subtasks: Subtask[];
  dependsOn: string[];
  repeat: "none" | Recurrence["freq"];
  repeatDays: number[];
  repeatTime: string;
  notes: string;
  links: { url: string; label?: string }[];
}

function toDraft(t: Task): Draft {
  return {
    title: t.title,
    description: t.description,
    priority: t.priority,
    estimateMin: t.estimateMin,
    energy: t.energy,
    plannedDate: t.plannedDate ?? "",
    start: t.scheduledStart ? timeOf(t.scheduledStart) : "",
    pinned: t.pinned,
    dueDate: t.dueAt ? dateOf(t.dueAt) : "",
    dueTime: t.dueAt ? timeOf(t.dueAt) : "",
    dueHard: t.dueHard,
    startDate: t.startDate ?? "",
    projectId: t.projectId ?? "",
    category: t.category ?? "",
    tags: t.tags.join(", "),
    subtasks: t.subtasks,
    dependsOn: t.dependsOn,
    repeat: t.recurrence?.freq ?? "none",
    repeatDays: t.recurrence?.byWeekday ?? [],
    repeatTime: t.recurrence?.time ?? "",
    notes: t.notes,
    links: t.links,
  };
}

function buildPatch(task: Task, d: Draft): TaskPatch {
  const p: TaskPatch = {};
  const isSeries = task.recurrence !== null && task.recurrenceParentId === null;
  if (d.title.trim() !== task.title) p.title = d.title.trim();
  if (d.description !== task.description) p.description = d.description;
  if (d.priority !== task.priority) p.priority = d.priority;
  if (d.estimateMin !== task.estimateMin) p.estimateMin = d.estimateMin;
  if (d.energy !== task.energy) p.energy = d.energy;
  if (!isSeries) {
    const planned = d.plannedDate || null;
    const start = planned && d.start ? combine(planned, d.start) : null;
    if (start !== task.scheduledStart) p.scheduledStart = start;
    if (planned !== task.plannedDate) p.plannedDate = planned;
    if (start && d.pinned !== task.pinned) p.pinned = d.pinned;
    if (start && p.scheduledStart) p.pinned = d.pinned;
  }
  const due = d.dueDate ? combine(d.dueDate, d.dueTime || "23:59") : null;
  if (due !== task.dueAt) p.dueAt = due;
  if (d.dueHard !== task.dueHard) p.dueHard = d.dueHard;
  if ((d.startDate || null) !== task.startDate) p.startDate = d.startDate || null;
  if ((d.projectId || null) !== task.projectId) p.projectId = d.projectId || null;
  if ((d.category.trim() || null) !== task.category) p.category = d.category.trim() || null;
  const tags = d.tags.split(",").map((x) => x.trim().replace(/^#/, "")).filter(Boolean);
  if (JSON.stringify(tags) !== JSON.stringify(task.tags)) p.tags = tags;
  const subtasks = d.subtasks.filter((s) => s.title.trim()).map((s) => ({ ...s, title: s.title.trim() }));
  if (JSON.stringify(subtasks) !== JSON.stringify(task.subtasks)) p.subtasks = subtasks;
  if (JSON.stringify(d.dependsOn) !== JSON.stringify(task.dependsOn)) p.dependsOn = d.dependsOn;
  if (d.notes !== task.notes) p.notes = d.notes;
  if (JSON.stringify(d.links) !== JSON.stringify(task.links)) p.links = d.links;
  if (!task.recurrenceParentId) {
    const rec: Recurrence | null =
      d.repeat === "none"
        ? null
        : {
            freq: d.repeat,
            interval: task.recurrence?.interval ?? 1,
            ...(d.repeat === "weekly" && d.repeatDays.length ? { byWeekday: [...d.repeatDays].sort() } : {}),
            time: d.repeatTime || null,
            until: task.recurrence?.until ?? null,
            exDates: task.recurrence?.exDates ?? [],
          };
    if (JSON.stringify(rec) !== JSON.stringify(task.recurrence)) p.recurrence = rec;
  }
  return p;
}

export function TaskEditorHost() {
  const ui = useUi();
  const id = ui.editingTaskId;
  const q = useQuery({ queryKey: ["task", id], queryFn: () => api.task(id!), enabled: Boolean(id), staleTime: 0 });
  const close = () => ui.set({ editingTaskId: null });
  if (!id) return null;
  return (
    <Dialog open onClose={close} size="lg" labelledBy="task-editor-title">
      {q.isLoading && (
        <div className="dialog-body" style={{ alignItems: "center", padding: 40 }}>
          <Spinner />
        </div>
      )}
      {q.isError && <div className="dialog-body">{(q.error as Error).message}</div>}
      {q.data && <TaskEditor key={q.data.id + q.data.rev} task={q.data} onClose={close} />}
    </Dialog>
  );
}

function TaskEditor({ task, onClose }: { task: Task; onClose: () => void }) {
  const t = useT();
  const lang = useLang();
  const run = useAction();
  const actions = useTaskActions();
  const projects = useProjects();
  const allTasks = useTasks("open");
  const ui = useUi();
  const [d, setD] = useState<Draft>(() => toDraft(task));
  const [saving, setSaving] = useState(false);
  const [newSub, setNewSub] = useState("");
  const [newLink, setNewLink] = useState("");
  const isSeries = task.recurrence !== null && task.recurrenceParentId === null;
  const done = task.status === "done";
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const patch = useMemo(() => buildPatch(task, d), [task, d]);
  const dirty = Object.keys(patch).length > 0;
  const titles = new Map((allTasks.data ?? []).map((x) => [x.id, x.title]));
  const depOptions = (allTasks.data ?? []).filter((x) => x.id !== task.id && !d.dependsOn.includes(x.id) && x.recurrenceParentId === null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const save = async () => {
    if (!d.title.trim()) return;
    if (!dirty) return onClose();
    setSaving(true);
    const res = await run(() => api.updateTask(task.id, patch), { success: t("toast.saved"), undoLabel: t("common.undo") });
    setSaving(false);
    if (res) onClose();
  };

  return (
    <>
      <div className="dialog-header editor-header">
        <PriorityIcon priority={d.priority} />
        <input
          className="editor-title"
          value={d.title}
          onChange={(e) => set("title", e.target.value)}
          placeholder={t("task.titlePlaceholder")}
          aria-label={t("task.title")}
          id="task-editor-title"
          data-autofocus
          aria-invalid={!d.title.trim()}
        />
        <button type="button" className="icon-btn" aria-label={t("common.close")} onClick={onClose}>
          <X />
        </button>
      </div>
      <div className="dialog-body editor-body">
        {isSeries && (
          <div className="callout callout-accent">
            <Repeat />
            <div>
              <strong>{t("task.series")}.</strong> {t("task.seriesHint")}
            </div>
          </div>
        )}
        {task.recurrenceParentId && (
          <div className="callout">
            <Repeat />
            <div className="row" style={{ flex: 1 }}>
              <span>{t("state.recurring")}</span>
              <span className="spacer" />
              <Button size="sm" variant="ghost" onClick={() => ui.set({ editingTaskId: task.recurrenceParentId })}>
                {t("task.series")}
              </Button>
            </div>
          </div>
        )}
        <textarea className="textarea editor-desc" value={d.description} onChange={(e) => set("description", e.target.value)} placeholder={t("task.description")} rows={2} aria-label={t("task.description")} />

        <div className="editor-grid">
          <Field label={t("task.priority")}>
            <select className="select" value={d.priority} onChange={(e) => set("priority", e.target.value as Task["priority"])}>
              {PRIORITY_ORDER.map((p) => (
                <option key={p} value={p}>
                  {t(`priority.${p}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("task.estimate")}>
            <select className="select" value={d.estimateMin} onChange={(e) => set("estimateMin", Number(e.target.value))}>
              {[...new Set([...ESTIMATES, d.estimateMin])].sort((a, b) => a - b).map((m) => (
                <option key={m} value={m}>
                  {m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${m % 60 ? String(m % 60).padStart(2, "0") : ""}`}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("task.energy")}>
            <select className="select" value={d.energy} onChange={(e) => set("energy", e.target.value as Task["energy"])}>
              {(["high", "medium", "low"] as const).map((x) => (
                <option key={x} value={x}>
                  {t(`energy.${x}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("task.project")}>
            <select className="select" value={d.projectId} onChange={(e) => set("projectId", e.target.value)}>
              <option value="">{t("task.noProject")}</option>
              {(projects.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {!isSeries && (
          <div className="editor-grid">
            <Field label={t("task.plannedDate")}>
              <input className="input" type="date" value={d.plannedDate} onChange={(e) => set("plannedDate", e.target.value)} />
            </Field>
            <Field label={t("task.start")}>
              <input className="input" type="time" value={d.start} onChange={(e) => set("start", e.target.value)} disabled={!d.plannedDate} step={300} />
            </Field>
            <div className="field field-switch">
              <span className="field-label">{t("task.pinned")}</span>
              <Switch checked={d.pinned && Boolean(d.start)} onChange={(v) => set("pinned", v)} label={t("task.pinned")} disabled={!d.start} />
            </div>
          </div>
        )}

        <div className="editor-grid">
          <Field label={t("task.due")}>
            <div className="row" style={{ gap: 6 }}>
              <input className="input" type="date" value={d.dueDate} onChange={(e) => set("dueDate", e.target.value)} />
              <input className="input" type="time" value={d.dueTime} onChange={(e) => set("dueTime", e.target.value)} disabled={!d.dueDate} style={{ width: 110 }} />
            </div>
          </Field>
          <div className="field field-switch">
            <span className="field-label">{t("task.dueHard")}</span>
            <Switch checked={d.dueHard} onChange={(v) => set("dueHard", v)} label={t("task.dueHard")} disabled={!d.dueDate} />
          </div>
          <Field label={t("task.startDate")}>
            <input className="input" type="date" value={d.startDate} onChange={(e) => set("startDate", e.target.value)} />
          </Field>
        </div>

        <div className="editor-section">
          <div className="section-title">
            {t("task.subtasks")}
            {d.subtasks.length > 0 && (
              <span className="count tnum">
                {d.subtasks.filter((s) => s.done).length}/{d.subtasks.length}
              </span>
            )}
          </div>
          <ul className="subtask-list">
            {d.subtasks.map((s, i) => (
              <li key={s.id} className={`subtask ${s.done ? "is-done" : ""}`}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={s.done}
                  className={`task-check ${s.done ? "is-checked" : ""}`}
                  style={{ width: 15, height: 15 }}
                  onClick={() => set("subtasks", d.subtasks.map((x, j) => (j === i ? { ...x, done: !x.done } : x)))}
                >
                  {s.done && <Check strokeWidth={3} />}
                </button>
                <input className="input input-bare" value={s.title} onChange={(e) => set("subtasks", d.subtasks.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} aria-label={t("task.subtasks")} />
                <button type="button" className="icon-btn icon-btn-sm" aria-label={t("common.delete")} onClick={() => set("subtasks", d.subtasks.filter((_, j) => j !== i))}>
                  <X />
                </button>
              </li>
            ))}
            <li className="subtask subtask-add">
              <Plus />
              <input
                className="input input-bare"
                value={newSub}
                placeholder={t("task.addSubtask")}
                onChange={(e) => setNewSub(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newSub.trim()) {
                    e.preventDefault();
                    set("subtasks", [...d.subtasks, { id: newSubtaskId(), title: newSub.trim(), done: false }]);
                    setNewSub("");
                  }
                }}
              />
            </li>
          </ul>
        </div>

        {!task.recurrenceParentId && !isSeries && (
          <div className="editor-section">
            <div className="section-title">{t("task.dependencies")}</div>
            <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
              {d.dependsOn.map((id) => (
                <span key={id} className="chip">
                  <Link2 />
                  {titles.get(id) ?? id}
                  <button type="button" aria-label={t("common.delete")} onClick={() => set("dependsOn", d.dependsOn.filter((x) => x !== id))}>
                    <X />
                  </button>
                </span>
              ))}
              {depOptions.length > 0 && (
                <select className="select select-sm" style={{ width: "auto", minWidth: 200 }} value="" onChange={(e) => e.target.value && set("dependsOn", [...d.dependsOn, e.target.value])} aria-label={t("task.addDependency")}>
                  <option value="">{t("task.addDependency")}</option>
                  {depOptions.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.title}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>
        )}

        {!task.recurrenceParentId && (
          <div className="editor-section">
            <div className="section-title">{t("task.recurrence")}</div>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <select className="select select-sm" style={{ width: "auto" }} value={d.repeat} onChange={(e) => set("repeat", e.target.value as Draft["repeat"])} aria-label={t("task.recurrence")}>
                <option value="none">{t("task.repeat.none")}</option>
                <option value="daily">{t("task.repeat.daily")}</option>
                <option value="weekly">{t("task.repeat.weekly")}</option>
                <option value="monthly">{t("task.repeat.monthly")}</option>
              </select>
              {d.repeat === "weekly" && (
                <div className="weekday-picker" role="group" aria-label={t("task.repeatOn")}>
                  {t("weekday.short")
                    .split(",")
                    .map((label, i) => (
                      <button
                        key={label}
                        type="button"
                        aria-pressed={d.repeatDays.includes(i + 1)}
                        onClick={() => set("repeatDays", d.repeatDays.includes(i + 1) ? d.repeatDays.filter((x) => x !== i + 1) : [...d.repeatDays, i + 1])}
                      >
                        {label}
                      </button>
                    ))}
                </div>
              )}
              {d.repeat !== "none" && (
                <input className="input input-sm" type="time" value={d.repeatTime} onChange={(e) => set("repeatTime", e.target.value)} style={{ width: 110 }} aria-label={t("task.start")} />
              )}
            </div>
          </div>
        )}

        <div className="editor-grid">
          <Field label={t("task.tags")}>
            <input className="input" value={d.tags} onChange={(e) => set("tags", e.target.value)} placeholder={t("task.tagsPlaceholder")} />
          </Field>
          <Field label={t("task.category")}>
            <input className="input" value={d.category} onChange={(e) => set("category", e.target.value)} />
          </Field>
        </div>

        <Field label={t("task.notes")}>
          <textarea className="textarea" value={d.notes} onChange={(e) => set("notes", e.target.value)} rows={3} />
        </Field>

        <div className="editor-section">
          <div className="section-title">{t("task.links")}</div>
          {d.links.map((l, i) => (
            <div key={l.url + i} className="row link-row">
              <Link2 className="faint" style={{ width: 14 }} />
              <a href={l.url} target="_blank" rel="noreferrer noopener" className="truncate">
                {l.label ?? l.url}
              </a>
              <button type="button" className="icon-btn icon-btn-sm" aria-label={t("common.delete")} onClick={() => set("links", d.links.filter((_, j) => j !== i))}>
                <X />
              </button>
            </div>
          ))}
          <input
            className="input input-sm"
            value={newLink}
            placeholder={`${t("task.addLink")} (https://…)`}
            onChange={(e) => setNewLink(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && /^https?:\/\/\S+$/.test(newLink.trim())) {
                e.preventDefault();
                set("links", [...d.links, { url: newLink.trim() }]);
                setNewLink("");
              }
            }}
          />
        </div>

        <div className="editor-foot-meta faint">
          {t("task.created", { when: relativeTime(task.createdAt, lang) })}
          {task.completedAt && ` · ${t("task.completedAt", { when: relativeTime(task.completedAt, lang) })}`}
          {task.actualMin ? ` · ${t("task.actual")}: ${task.actualMin} min` : ""}
          {task.postponedCount > 0 ? ` · ${t("task.postponedTimes", { n: task.postponedCount })}` : ""}
        </div>
      </div>
      <div className="dialog-footer">
        <Button
          variant="danger-ghost"
          icon={<Trash2 />}
          onClick={async () => {
            onClose();
            await actions.remove(task);
          }}
        >
          {t("common.delete")}
        </Button>
        {!isSeries && (
          <Button
            variant="ghost"
            icon={done ? <RotateCcw /> : <Check />}
            onClick={async () => {
              await actions.toggle(task, "");
              onClose();
            }}
          >
            {done ? t("action.reopen") : t("action.complete")}
          </Button>
        )}
        <span className="spacer" />
        <Button variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" onClick={() => void save()} loading={saving} disabled={!d.title.trim()}>
          {t("common.save")}
        </Button>
      </div>
    </>
  );
}

export const taskStatusLabel = (s: Task["status"], t: (k: Key) => string) => t(`status.${s}` as Key);
