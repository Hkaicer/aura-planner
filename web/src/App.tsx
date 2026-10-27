import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { AssistantPanel } from "./assistant/AssistantPanel";
import { CommandPalette } from "./components/CommandPalette";
import { EventEditorHost } from "./components/EventEditor";
import { EveningReview, MorningPlanning, Onboarding, ShortcutsDialog } from "./components/Flows";
import { FocusHost } from "./components/FocusMode";
import { QuickAddHost } from "./components/QuickAdd";
import { ResizeHandle } from "./components/ResizeHandle";
import { ScheduleDialogHost } from "./components/ScheduleDialog";
import { Sidebar } from "./components/Sidebar";
import { TaskEditorHost } from "./components/TaskEditor";
import { ConfirmHost, Toaster, isDialogOpen } from "./components/ui";
import { api } from "./lib/api";
import { useT } from "./lib/i18n";
import { errorMessage, invalidatePlanning, useBootstrap, useDay, useNow } from "./lib/queries";
import { ASSISTANT_DOCK_MIN, MAIN_MIN_W, SIDEBAR_W, useUi, viewFromHash, widthOf, type View } from "./lib/store";
import { toast } from "./lib/toast";
import { AllTasksView } from "./views/AllTasksView";
import { CalendarView } from "./views/CalendarView";
import { CompletedView } from "./views/CompletedView";
import { InboxView } from "./views/InboxView";
import { ProjectsView } from "./views/ProjectsView";
import { SettingsView } from "./views/SettingsView";
import { TodayView } from "./views/TodayView";
import { UpcomingView } from "./views/UpcomingView";

const GO: Record<string, View> = { t: "today", u: "upcoming", i: "inbox", a: "all", p: "projects", c: "calendar", d: "completed", s: "settings" };

function isTyping(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

function applyTheme(theme: "system" | "light" | "dark") {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  try {
    localStorage.setItem("aura.theme", theme);
  } catch {
    // theme still applies for this session
  }
}

export function App() {
  const t = useT();
  const ui = useUi();
  const qc = useQueryClient();
  const boot = useBootstrap();
  const now = useNow();
  const today = useDay(now.date);
  const settings = boot.data?.settings;
  const pendingG = useRef<number | null>(null);

  // Theme and document language follow settings.
  useEffect(() => {
    if (settings) {
      applyTheme(settings.theme);
      document.documentElement.lang = settings.language;
    }
  }, [settings]);

  // Column widths chosen by dragging their edges (remembered in this window).
  useLayoutEffect(() => {
    const style = document.documentElement.style;
    style.setProperty("--sidebar-w", `${ui.sidebarW}px`);
    style.setProperty("--assistant-w", `${ui.assistantW}px`);
  }, [ui.sidebarW, ui.assistantW]);

  // Heartbeat: keeps an app-launched server alive while this window is open, even minimized.
  useEffect(() => {
    const id = window.setInterval(() => void fetch("/api/health").catch(() => undefined), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // Back/forward navigation.
  useEffect(() => {
    const onPop = () => {
      const r = viewFromHash();
      useUi.setState({ view: r.view, projectId: r.projectId, settingsSection: r.settingsSection });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const undoLast = useCallback(async () => {
    try {
      const r = await api.undoLast();
      invalidatePlanning(qc);
      void qc.invalidateQueries({ queryKey: ["conversation"] });
      toast.show({ message: t("toast.undone", { label: r.label }) });
    } catch (err) {
      toast.show({ message: errorMessage(err) === "Nothing to undo." ? t("toast.nothingToUndo") : errorMessage(err) });
    }
  }, [qc, t]);

  const toggleTheme = useCallback(async () => {
    const dark = document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && window.matchMedia("(prefers-color-scheme: dark)").matches);
    const next = dark ? "light" : "dark";
    applyTheme(next);
    try {
      const s = await api.patchSettings({ theme: next });
      qc.setQueryData(["bootstrap"], (b: unknown) => (b && typeof b === "object" ? { ...(b as object), settings: s } : b));
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }, [qc]);

  const focusCurrent = useCallback(() => {
    const tasks = today.data?.tasks ?? [];
    const open = tasks.filter((x) => x.status !== "done" && x.status !== "cancelled");
    const current =
      open.find((x) => x.status === "in_progress") ??
      open.find((x) => x.scheduledStart && x.scheduledStart <= now.dateTime && (x.scheduledEnd ?? "") > now.dateTime) ??
      open.filter((x) => x.scheduledStart).sort((a, b) => a.scheduledStart!.localeCompare(b.scheduledStart!)).find((x) => (x.scheduledEnd ?? "") > now.dateTime) ??
      open[0];
    if (current) ui.set({ focusTaskId: current.id });
    else toast.show({ message: t("focus.noTask") });
  }, [today.data, now.dateTime, ui, t]);

  const planToday = useCallback(() => {
    ui.setView("today");
    window.setTimeout(() => document.querySelector<HTMLButtonElement>(".split-btn .btn")?.click(), 60);
  }, [ui]);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        ui.set({ paletteOpen: !ui.paletteOpen });
        return;
      }
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey && !isTyping(e) && !isDialogOpen()) {
        e.preventDefault();
        void undoLast();
        return;
      }
      if (mod && e.key.toLowerCase() === "j") {
        e.preventDefault();
        ui.toggleAssistant();
        return;
      }
      if (mod || e.altKey || isTyping(e) || isDialogOpen() || ui.focusTaskId) return;
      const k = e.key.toLowerCase();
      if (pendingG.current !== null) {
        window.clearTimeout(pendingG.current);
        pendingG.current = null;
        const view = GO[k];
        if (view) {
          e.preventDefault();
          ui.setView(view, view === "projects" ? { projectId: null } : {});
        }
        return;
      }
      if (k === "g") {
        pendingG.current = window.setTimeout(() => (pendingG.current = null), 900);
        return;
      }
      if (k === "n" || k === "q") {
        e.preventDefault();
        ui.set({ quickAdd: {} });
      } else if (k === "j") {
        e.preventDefault();
        ui.toggleAssistant();
      } else if (k === "/") {
        e.preventDefault();
        ui.toggleAssistant(true);
        window.setTimeout(() => window.dispatchEvent(new Event("aura:focus-assistant")), 40);
      } else if (k === "f") {
        e.preventDefault();
        focusCurrent();
      } else if (e.key === "?") {
        e.preventDefault();
        ui.set({ dialog: "shortcuts" });
      } else if (ui.view === "today" && (k === "1" || k === "2" || k === "3")) {
        ui.set({ todayMode: k === "1" ? "timeline" : k === "2" ? "list" : "priority" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ui, undoLast, focusCurrent]);

  // Optional reminders shortly before a scheduled task starts (while AURA is open).
  const notified = useRef(new Set<string>());
  useEffect(() => {
    if (!settings?.notifications.enabled || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const lead = settings.notifications.minutesBefore;
    for (const task of today.data?.tasks ?? []) {
      if (!task.scheduledStart || task.status === "done" || notified.current.has(task.id + task.scheduledStart)) continue;
      const [h, m] = task.scheduledStart.slice(11).split(":").map(Number) as [number, number];
      const minutesUntil = h * 60 + m - now.minutes;
      if (minutesUntil <= lead && minutesUntil >= 0) {
        notified.current.add(task.id + task.scheduledStart);
        try {
          new Notification(task.title, { body: `${task.scheduledStart.slice(11)} · ${task.estimateMin} min`, tag: task.id });
        } catch {
          // ignore notification failures
        }
      }
    }
  }, [now.minutes, today.data, settings]);

  if (boot.isError) {
    return (
      <div className="fatal">
        <h1>AURA</h1>
        <p>{errorMessage(boot.error)}</p>
        <button type="button" className="btn" onClick={() => void boot.refetch()}>
          {t("common.retry")}
        </button>
      </div>
    );
  }

  return (
    <div className="app">
      <Sidebar />
      <ResizeHandle
        edge="right"
        className="sidebar-resize"
        cssVar="--sidebar-w"
        range={SIDEBAR_W}
        value={ui.sidebarW}
        measure={() => widthOf(".sidebar")}
        available={() => window.innerWidth - (window.innerWidth >= ASSISTANT_DOCK_MIN ? widthOf(".assistant") : 0) - MAIN_MIN_W}
        label={t("layout.resizeSidebar")}
        onCommit={(w) => ui.set({ sidebarW: w })}
      />
      <div className={`scrim ${ui.sidebarOpen ? "is-open" : ""}`} onClick={() => ui.set({ sidebarOpen: false })} aria-hidden />
      <main className="main">
        {ui.view === "today" && <TodayView />}
        {ui.view === "upcoming" && <UpcomingView />}
        {ui.view === "all" && <AllTasksView />}
        {ui.view === "inbox" && <InboxView />}
        {ui.view === "projects" && <ProjectsView />}
        {ui.view === "calendar" && <CalendarView />}
        {ui.view === "completed" && <CompletedView />}
        {ui.view === "settings" && <SettingsView />}
      </main>
      {ui.assistantOpen && <div className="assistant-scrim" onClick={() => ui.toggleAssistant(false)} aria-hidden />}
      {ui.assistantOpen && <AssistantPanel />}

      <TaskEditorHost />
      <QuickAddHost />
      <ScheduleDialogHost />
      <EventEditorHost />
      <FocusHost />
      <CommandPalette onUndo={() => void undoLast()} onToggleTheme={() => void toggleTheme()} onPlanToday={planToday} onFocus={focusCurrent} />
      {ui.dialog === "morning" && <MorningPlanning onClose={() => ui.set({ dialog: null })} />}
      {ui.dialog === "evening" && <EveningReview onClose={() => ui.set({ dialog: null })} />}
      {ui.dialog === "shortcuts" && <ShortcutsDialog onClose={() => ui.set({ dialog: null })} />}
      <Onboarding />
      <ConfirmHost />
      <Toaster />
    </div>
  );
}
