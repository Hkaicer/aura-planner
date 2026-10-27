import { Repeat, Search, SearchX } from "lucide-react";
import { useMemo, useState } from "react";
import type { Task } from "@shared/schemas";
import { TaskRow, useRowContext } from "../components/task";
import { Empty, ErrorState } from "../components/ui";
import { ViewHeader } from "../components/ViewHeader";
import { ListSkeleton } from "./CompletedView";
import { relativeDay } from "../lib/format";
import { useLang, useT } from "../lib/i18n";
import { errorMessage, useNow, useProjects, useTasks } from "../lib/queries";
import { PRIORITY_ORDER } from "../lib/tasks";
import { describeRecurrence } from "../lib/recurrence";

type Status = "open" | "done" | "all";
type Sort = "smart" | "deadline" | "planned" | "created" | "title";
type Group = "none" | "project" | "day";

const PRIORITY_RANK: Record<Task["priority"], number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function AllTasksView() {
  const t = useT();
  const lang = useLang();
  const now = useNow();
  const all = useTasks("all");
  const templates = useTasks("templates");
  const projects = useProjects();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<Status>("open");
  const [priority, setPriority] = useState<"" | Task["priority"]>("");
  const [project, setProject] = useState("");
  const [sort, setSort] = useState<Sort>("smart");
  const [group, setGroup] = useState<Group>("none");
  const ctx = useRowContext([], projects.data, now, all.data);

  const filtered = useMemo(() => {
    const text = q.trim().toLowerCase();
    const list = (all.data ?? [])
      .filter((x) => x.status !== "inbox")
      .filter((x) => (status === "open" ? x.status !== "done" && x.status !== "cancelled" : status === "done" ? x.status === "done" : true))
      .filter((x) => (priority ? x.priority === priority : true))
      .filter((x) => (project ? (project === "none" ? !x.projectId : x.projectId === project) : true))
      .filter((x) => (text ? `${x.title} ${x.description} ${x.notes} ${x.tags.join(" ")}`.toLowerCase().includes(text) : true));
    const cmp: Record<Sort, (a: Task, b: Task) => number> = {
      smart: (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || (a.dueAt ?? "~").localeCompare(b.dueAt ?? "~") || (a.plannedDate ?? "~").localeCompare(b.plannedDate ?? "~"),
      deadline: (a, b) => (a.dueAt ?? "~").localeCompare(b.dueAt ?? "~"),
      planned: (a, b) => (a.plannedDate ?? "~").localeCompare(b.plannedDate ?? "~") || (a.scheduledStart ?? "~").localeCompare(b.scheduledStart ?? "~"),
      created: (a, b) => b.createdAt.localeCompare(a.createdAt),
      title: (a, b) => a.title.localeCompare(b.title),
    };
    return list.sort(cmp[sort]);
  }, [all.data, q, status, priority, project, sort]);

  const groups = useMemo(() => {
    if (group === "none") return [{ key: "all", label: "", tasks: filtered }];
    const map = new Map<string, Task[]>();
    for (const task of filtered) {
      const key = group === "project" ? (task.projectId ?? "") : (task.plannedDate ?? "");
      map.set(key, [...(map.get(key) ?? []), task]);
    }
    return [...map.entries()]
      .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))
      .map(([key, tasks]) => ({
        key,
        label:
          group === "project"
            ? (projects.data?.find((p) => p.id === key)?.name ?? t("task.noProject"))
            : key
              ? relativeDay(key, now.date, lang, t)
              : t("task.noDate"),
        tasks,
      }));
  }, [filtered, group, projects.data, now.date, lang, t]);

  return (
    <>
      <ViewHeader title={t("all.title")} sub={t("all.count", { n: filtered.length })} />
      <div className="view-body">
        <div className="view-inner view-inner-narrow">
          <div className="toolbar">
            <div className="search-box">
              <Search />
              <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("all.search")} aria-label={t("all.search")} />
            </div>
            <select className="select select-sm" value={status} onChange={(e) => setStatus(e.target.value as Status)} aria-label={t("all.filter.status")}>
              <option value="open">{t("all.filter.open")}</option>
              <option value="done">{t("all.filter.done")}</option>
              <option value="all">{t("all.filter.all")}</option>
            </select>
            <select className="select select-sm" value={priority} onChange={(e) => setPriority(e.target.value as "" | Task["priority"])} aria-label={t("all.filter.priority")}>
              <option value="">{t("all.filter.anyPriority")}</option>
              {PRIORITY_ORDER.map((p) => (
                <option key={p} value={p}>
                  {t(`priority.${p}`)}
                </option>
              ))}
            </select>
            <select className="select select-sm" value={project} onChange={(e) => setProject(e.target.value)} aria-label={t("all.filter.project")}>
              <option value="">{t("all.filter.anyProject")}</option>
              <option value="none">{t("task.noProject")}</option>
              {(projects.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select className="select select-sm" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label={t("all.sort")}>
              {(["smart", "deadline", "planned", "created", "title"] as Sort[]).map((s) => (
                <option key={s} value={s}>
                  {t(`all.sort.${s}`)}
                </option>
              ))}
            </select>
            <select className="select select-sm" value={group} onChange={(e) => setGroup(e.target.value as Group)} aria-label={t("all.group")}>
              {(["none", "project", "day"] as Group[]).map((g) => (
                <option key={g} value={g}>
                  {t(`all.group.${g}`)}
                </option>
              ))}
            </select>
          </div>

          {all.isLoading && <ListSkeleton />}
          {all.isError && <ErrorState message={errorMessage(all.error)} onRetry={() => void all.refetch()} />}
          {all.data && filtered.length === 0 && <Empty icon={<SearchX />} title={t("all.empty")} small />}
          {groups.map((g) =>
            g.tasks.length === 0 ? null : (
              <section key={g.key} className="group">
                {g.label && (
                  <div className="group-head">
                    {g.label}
                    <span className="count">{g.tasks.length}</span>
                  </div>
                )}
                <div className="task-list">
                  {g.tasks.map((task) => (
                    <TaskRow key={task.id} task={task} ctx={ctx} showDate />
                  ))}
                </div>
              </section>
            ),
          )}

          {(templates.data ?? []).length > 0 && status !== "done" && (
            <section className="group">
              <div className="group-head">
                <Repeat className="faint" style={{ width: 14 }} />
                {t("all.recurring")}
                <span className="count">{templates.data!.length}</span>
              </div>
              <div className="task-list">
                {templates.data!.map((task) => (
                  <TaskRow key={task.id} task={task} ctx={ctx} showTime={false} extra={<span className="faint recurrence-label">{task.recurrence ? describeRecurrence(task.recurrence, lang) : ""}</span>} />
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
