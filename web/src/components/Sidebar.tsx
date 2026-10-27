import {
  CalendarDays,
  CalendarRange,
  CheckCircle2,
  FolderKanban,
  Inbox,
  ListTodo,
  Plus,
  Search,
  Settings,
  Sparkles,
  Sun,
} from "lucide-react";
import type { ReactNode } from "react";
import { useT, type Key } from "../lib/i18n";
import { useAiStatus, useDay, useNow, useProjects, useTasks } from "../lib/queries";
import { useUi, type View } from "../lib/store";
import { Kbd, ProgressRing } from "./ui";

const NAV: { view: View; icon: ReactNode; label: Key; shortcut: string }[] = [
  { view: "today", icon: <Sun />, label: "nav.today", shortcut: "G T" },
  { view: "upcoming", icon: <CalendarRange />, label: "nav.upcoming", shortcut: "G U" },
  { view: "inbox", icon: <Inbox />, label: "nav.inbox", shortcut: "G I" },
  { view: "all", icon: <ListTodo />, label: "nav.all", shortcut: "G A" },
  { view: "projects", icon: <FolderKanban />, label: "nav.projects", shortcut: "G P" },
  { view: "calendar", icon: <CalendarDays />, label: "nav.calendar", shortcut: "G C" },
  { view: "completed", icon: <CheckCircle2 />, label: "nav.completed", shortcut: "G D" },
];

export function AuraMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden className="aura-mark">
      <rect width="64" height="64" rx="16" fill="var(--accent)" />
      <circle cx="32" cy="32" r="15" fill="none" stroke="#fff" strokeWidth="5" strokeOpacity="0.95" />
      <circle cx="32" cy="32" r="5.5" fill="#fff" />
    </svg>
  );
}

export function Sidebar() {
  const t = useT();
  const ui = useUi();
  const now = useNow();
  const day = useDay(now.date);
  const inbox = useTasks("inbox");
  const projects = useProjects();
  const ai = useAiStatus();

  const remaining = day.data ? day.data.tasks.filter((x) => x.status !== "done" && x.status !== "cancelled").length : 0;
  const progress = day.data?.progress;
  const counts: Partial<Record<View, number>> = {
    today: remaining || undefined,
    inbox: inbox.data?.length || undefined,
  };
  const activeProjects = (projects.data ?? []).filter((p) => p.status === "active").slice(0, 6);
  const aiState = ai.data?.state;

  return (
    <aside className={`sidebar ${ui.sidebarOpen ? "is-open" : ""}`} aria-label="Main navigation">
      <div className="sb-brand">
        <AuraMark />
        <span className="sb-name">AURA</span>
      </div>

      <div className="sb-actions">
        <button type="button" className="sb-primary" onClick={() => ui.set({ quickAdd: {} })}>
          <Plus />
          <span>{t("nav.newTask")}</span>
          <Kbd>N</Kbd>
        </button>
        <button type="button" className="sb-search" onClick={() => ui.set({ paletteOpen: true })} aria-label={t("nav.search")}>
          <Search />
          <Kbd>Ctrl K</Kbd>
        </button>
      </div>

      <button type="button" className={`sb-ask ${ui.assistantOpen ? "is-active" : ""}`} onClick={() => ui.toggleAssistant()} aria-pressed={ui.assistantOpen}>
        <Sparkles />
        <span>{t("nav.ask")}</span>
        <span className={`sb-ai-dot is-${aiState === "ready" ? "ready" : aiState === "disabled" ? "off" : aiState ? "warn" : "checking"}`} />
        <Kbd>J</Kbd>
      </button>

      <nav className="sb-nav">
        {NAV.map((n) => (
          <button
            key={n.view}
            type="button"
            className={`sb-item ${ui.view === n.view ? "is-active" : ""}`}
            aria-current={ui.view === n.view ? "page" : undefined}
            onClick={() => ui.setView(n.view, n.view === "projects" ? { projectId: null } : {})}
            title={`${t(n.label)} (${n.shortcut})`}
          >
            {n.icon}
            <span className="truncate">{t(n.label)}</span>
            {counts[n.view] !== undefined && <span className="sb-count tnum">{counts[n.view]}</span>}
          </button>
        ))}
      </nav>

      {activeProjects.length > 0 && (
        <div className="sb-section">
          <div className="sb-section-title">{t("nav.projects")}</div>
          {activeProjects.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`sb-item sb-project ${ui.view === "projects" && ui.projectId === p.id ? "is-active" : ""}`}
              onClick={() => ui.setView("projects", { projectId: p.id })}
            >
              <span className="dot" style={{ background: p.color }} />
              <span className="truncate">{p.name}</span>
              {p.stats.total > 0 && <span className="sb-count tnum">{p.stats.pct}%</span>}
            </button>
          ))}
        </div>
      )}

      <div className="sb-footer">
        <button type="button" className="sb-progress" onClick={() => ui.setView("today")}>
          <ProgressRing value={progress && progress.total ? progress.done / progress.total : 0} size={30} />
          <div className="sb-progress-text">
            <span className="sb-progress-title">{t("nav.todayProgress")}</span>
            <span className="tnum">
              {progress && progress.total ? t("nav.ofDone", { done: progress.done, total: progress.total }) : t("nav.nothingToday")}
            </span>
          </div>
          {progress && progress.total > 0 && <span className="sb-pct tnum">{progress.pct}%</span>}
        </button>
        <button
          type="button"
          className={`sb-item ${ui.view === "settings" ? "is-active" : ""}`}
          aria-current={ui.view === "settings" ? "page" : undefined}
          onClick={() => ui.setView("settings")}
        >
          <Settings />
          <span>{t("nav.settings")}</span>
        </button>
      </div>
    </aside>
  );
}
