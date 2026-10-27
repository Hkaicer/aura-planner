import { Archive, ArchiveRestore, ArrowLeft, CalendarClock, FolderKanban, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { diffDays, formatDuration } from "@shared/time";
import { TaskRow, useRowContext } from "../components/task";
import { Badge, Button, confirmAction, Dialog, Empty, ErrorState, Field, Menu } from "../components/ui";
import { ViewHeader } from "../components/ViewHeader";
import { api, type ProjectWithStats } from "../lib/api";
import { fmtDate } from "../lib/format";
import { useLang, useT } from "../lib/i18n";
import { errorMessage, useAction, useNow, useProjects, useTasks } from "../lib/queries";
import { useUi } from "../lib/store";

const COLORS = ["#5b7cfa", "#2fb47c", "#e5933a", "#d9577b", "#8a6cf0", "#2aa5b8", "#a3a3a3", "#c2554d"];

export function ProjectsView() {
  const t = useT();
  const ui = useUi();
  const projects = useProjects();
  const [editing, setEditing] = useState<ProjectWithStats | "new" | null>(null);
  const selected = ui.projectId ? projects.data?.find((p) => p.id === ui.projectId) : undefined;
  const active = (projects.data ?? []).filter((p) => p.status === "active");
  const archived = (projects.data ?? []).filter((p) => p.status === "archived");

  if (selected) return <ProjectDetail project={selected} onEdit={() => setEditing(selected)} editing={editing} setEditing={setEditing} />;

  return (
    <>
      <ViewHeader
        title={t("projects.title")}
        actions={
          <Button variant="primary" icon={<Plus />} onClick={() => setEditing("new")}>
            {t("projects.new")}
          </Button>
        }
      />
      <div className="view-body">
        <div className="view-inner">
          {projects.isLoading && <div className="skeleton" style={{ height: 200, borderRadius: 12 }} />}
          {projects.isError && <ErrorState message={errorMessage(projects.error)} onRetry={() => void projects.refetch()} />}
          {projects.data && projects.data.length === 0 && (
            <Empty icon={<FolderKanban />} title={t("projects.empty.title")} body={t("projects.empty.body")}>
              <Button variant="primary" icon={<Plus />} onClick={() => setEditing("new")}>
                {t("projects.new")}
              </Button>
            </Empty>
          )}
          <div className="project-grid">
            {active.map((p) => (
              <ProjectCard key={p.id} project={p} />
            ))}
          </div>
          {archived.length > 0 && (
            <section className="group" style={{ marginTop: 32 }}>
              <div className="group-head">
                {t("projects.archived")}
                <span className="count">{archived.length}</span>
              </div>
              <div className="project-grid">
                {archived.map((p) => (
                  <ProjectCard key={p.id} project={p} />
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
      {editing && <ProjectDialog project={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function DeadlineBadge({ deadline }: { deadline: string }) {
  const t = useT();
  const lang = useLang();
  const now = useNow();
  const days = diffDays(deadline, now.date);
  const tone = days < 0 ? "danger" : days <= 3 ? "warning" : "neutral";
  return (
    <Badge tone={tone}>
      <CalendarClock />
      {days < 0 ? t("projects.overdue") : days === 0 ? t("projects.dueToday") : days <= 14 ? t("projects.daysLeft", { n: days }) : fmtDate(deadline, lang, { day: "numeric", month: "short" })}
    </Badge>
  );
}

function ProjectCard({ project }: { project: ProjectWithStats }) {
  const t = useT();
  const ui = useUi();
  return (
    <button type="button" className={`project-card ${project.status === "archived" ? "is-archived" : ""}`} onClick={() => ui.setView("projects", { projectId: project.id })}>
      <div className="project-card-head">
        <span className="project-swatch" style={{ background: project.color }} />
        <span className="project-name truncate">{project.name}</span>
        {project.isDemo && <Badge tone="outline">demo</Badge>}
      </div>
      {project.description && <p className="project-desc">{project.description}</p>}
      <div className="project-progress">
        <div className="progress">
          <span style={{ width: `${project.stats.pct}%`, background: project.color }} />
        </div>
        <div className="project-foot">
          <span className="tnum">{t("projects.progress", { done: project.stats.done, total: project.stats.total })}</span>
          {project.stats.openMin > 0 && <span className="faint tnum">{t("projects.openWork", { time: formatDuration(project.stats.openMin) })}</span>}
          <span className="spacer" />
          {project.deadline && <DeadlineBadge deadline={project.deadline} />}
        </div>
      </div>
    </button>
  );
}

function ProjectDetail({
  project,
  onEdit,
  editing,
  setEditing,
}: {
  project: ProjectWithStats;
  onEdit: () => void;
  editing: ProjectWithStats | "new" | null;
  setEditing: (p: ProjectWithStats | "new" | null) => void;
}) {
  const t = useT();
  const ui = useUi();
  const now = useNow();
  const all = useTasks("all");
  const projects = useProjects();
  const run = useAction();
  const tasks = (all.data ?? []).filter((x) => x.projectId === project.id);
  const open = tasks.filter((x) => x.status !== "done" && x.status !== "cancelled").sort((a, b) => (a.plannedDate ?? "~").localeCompare(b.plannedDate ?? "~"));
  const done = tasks.filter((x) => x.status === "done");
  const ctx = useRowContext(tasks, projects.data, now, all.data);

  const remove = async () => {
    const { ok, option } = await confirmAction({
      title: t("projects.deleteConfirm", { name: project.name }),
      body: t("projects.deleteBody"),
      confirmLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
      danger: true,
      option: { label: t("projects.deleteWithTasks"), default: false },
    });
    if (!ok) return;
    ui.setView("projects", { projectId: null });
    await run(() => api.deleteProject(project.id, option), { success: t("toast.deleted", { title: project.name }), undoLabel: t("common.undo") });
  };

  return (
    <>
      <ViewHeader
        leading={
          <button type="button" className="icon-btn" aria-label={t("projects.all")} data-tip={t("projects.all")} onClick={() => ui.setView("projects", { projectId: null })}>
            <ArrowLeft />
          </button>
        }
        title={
          <span className="row" style={{ gap: 8 }}>
            <span className="project-swatch" style={{ background: project.color }} />
            {project.name}
          </span>
        }
        sub={t("projects.progress", { done: project.stats.done, total: project.stats.total })}
        actions={
          <>
            <Button icon={<Plus />} onClick={() => ui.set({ quickAdd: { projectId: project.id } })}>
              {t("projects.addTask")}
            </Button>
            <Menu
              label={t("common.more")}
              align="end"
              items={[
                { label: t("common.edit"), icon: <Pencil />, onSelect: onEdit },
                project.status === "active"
                  ? { label: t("projects.archive"), icon: <Archive />, onSelect: () => void run(() => api.updateProject(project.id, { status: "archived" }), { success: t("toast.saved"), undoLabel: t("common.undo") }) }
                  : { label: t("projects.unarchive"), icon: <ArchiveRestore />, onSelect: () => void run(() => api.updateProject(project.id, { status: "active" }), { success: t("toast.saved"), undoLabel: t("common.undo") }) },
                "sep",
                { label: t("common.delete"), icon: <Trash2 />, danger: true, onSelect: () => void remove() },
              ]}
              trigger={(p) => (
                <button type="button" className="icon-btn" aria-label={t("common.more")} {...p}>
                  <MoreHorizontal />
                </button>
              )}
            />
          </>
        }
      />
      <div className="view-body">
        <div className="view-inner view-inner-narrow">
          <div className="project-summary">
            {project.description && <p className="muted">{project.description}</p>}
            <div className="row" style={{ gap: 12 }}>
              <div className="progress" style={{ flex: 1 }}>
                <span style={{ width: `${project.stats.pct}%`, background: project.color }} />
              </div>
              <span className="tnum faint">{project.stats.pct}%</span>
              {project.deadline && <DeadlineBadge deadline={project.deadline} />}
            </div>
          </div>
          {tasks.length === 0 && <Empty small title={t("projects.noTasks")} />}
          {open.length > 0 && (
            <section className="group">
              <div className="group-head">
                {t("all.filter.open")}
                <span className="count">{open.length}</span>
              </div>
              <div className="task-list">
                {open.map((task) => (
                  <TaskRow key={task.id} task={task} ctx={ctx} showDate />
                ))}
              </div>
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
                  <TaskRow key={task.id} task={task} ctx={ctx} showDate />
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
      {editing && <ProjectDialog project={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function ProjectDialog({ project, onClose }: { project: ProjectWithStats | null; onClose: () => void }) {
  const t = useT();
  const run = useAction();
  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [deadline, setDeadline] = useState(project?.deadline ?? "");
  const [color, setColor] = useState(project?.color ?? COLORS[0]!);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    const body = { name: name.trim(), description, deadline: deadline || null, color };
    const res = project
      ? await run(() => api.updateProject(project.id, body), { success: t("toast.saved"), undoLabel: t("common.undo") })
      : await run(() => api.createProject(body), { success: t("toast.created", { title: body.name }), undoLabel: t("common.undo") });
    setSaving(false);
    if (res) onClose();
  };
  return (
    <Dialog open onClose={onClose} size="sm" title={project ? t("common.edit") : t("projects.new")} labelledBy="project-dialog-title">
      <div className="dialog-body">
        <Field label={t("projects.name")}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} data-autofocus maxLength={80} />
        </Field>
        <Field label={t("projects.description")}>
          <textarea className="textarea" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="field-row">
          <Field label={t("projects.deadline")}>
            <input className="input" type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          </Field>
          <div className="field">
            <span className="field-label">{t("projects.color")}</span>
            <div className="color-picker" role="radiogroup" aria-label={t("projects.color")}>
              {COLORS.map((c) => (
                <button key={c} type="button" role="radio" aria-checked={c === color} aria-label={c} style={{ background: c }} onClick={() => setColor(c)} />
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="dialog-footer">
        <Button variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" onClick={() => void save()} loading={saving} disabled={!name.trim()}>
          {t("common.save")}
        </Button>
      </div>
    </Dialog>
  );
}
