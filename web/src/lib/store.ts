import { create } from "zustand";

export type View = "today" | "upcoming" | "all" | "inbox" | "projects" | "calendar" | "completed" | "settings";
export type TodayMode = "timeline" | "list" | "priority";
export type Dialog = null | "morning" | "evening" | "shortcuts";
export type ChatText = "sm" | "md" | "lg";
export type BubbleWidth = "narrow" | "normal" | "wide";

/** Default and allowed widths (px) of the resizable side columns. */
export const SIDEBAR_W = { default: 236, min: 200, max: 400 };
export const ASSISTANT_W = { default: 404, min: 320, max: 760 };
/** Room always left for the main view when the assistant sits beside it (also in assistant.css). */
export const MAIN_MIN_W = 640;
/** Below this window width the assistant floats over the page instead of sitting beside it. */
export const ASSISTANT_DOCK_MIN = 1180;

/** Rendered width of an element of the app shell, 0 when it is not shown. */
export const widthOf = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().width ?? 0;

export function clampWidth(value: unknown, range: { default: number; min: number; max: number }): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : range.default;
  return Math.round(Math.min(range.max, Math.max(range.min, n)));
}

export interface QuickAddDefaults {
  plannedDate?: string | null;
  projectId?: string | null;
  start?: string | null;
  text?: string;
}

interface UiState {
  view: View;
  projectId: string | null;
  settingsSection: string;
  calendarDate: string | null;
  calendarMode: "day" | "week";
  todayMode: TodayMode;
  assistantOpen: boolean;
  sidebarOpen: boolean;
  sidebarW: number;
  assistantW: number;
  chatText: ChatText;
  bubbleW: BubbleWidth;
  paletteOpen: boolean;
  quickAdd: QuickAddDefaults | null;
  editingTaskId: string | null;
  focusTaskId: string | null;
  dialog: Dialog;
  scheduling: { taskId: string; mode: "schedule" | "move" } | null;
  editingEvent: { id: string | null; date: string; start: string; end: string; occurrence?: string } | null;
  assistantDraft: { text: string; send: boolean } | null;
  setView: (v: View, extra?: { projectId?: string | null; settingsSection?: string }) => void;
  set: (patch: Partial<UiState>) => void;
  toggleAssistant: (open?: boolean) => void;
  askAssistant: (text: string, send?: boolean) => void;
}

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage may be unavailable; preferences then reset on reload
  }
}

const VIEWS: View[] = ["today", "upcoming", "all", "inbox", "projects", "calendar", "completed", "settings"];

export function viewFromHash(): { view: View; projectId: string | null; settingsSection: string } {
  const [path, query] = window.location.hash.replace(/^#\/?/, "").split("?");
  const view = (VIEWS.includes(path as View) ? path : "today") as View;
  const params = new URLSearchParams(query ?? "");
  return { view, projectId: params.get("project"), settingsSection: params.get("section") ?? "general" };
}

const initial = viewFromHash();

export const useUi = create<UiState>((set, get) => ({
  view: initial.view,
  projectId: initial.projectId,
  settingsSection: initial.settingsSection,
  calendarDate: null,
  // A week is cramped on a phone: start on the day view there (the choice is remembered).
  calendarMode: load<"day" | "week">("aura.calendarMode", window.innerWidth <= 600 ? "day" : "week"),
  todayMode: load<TodayMode>("aura.todayMode", "timeline"),
  // On narrow screens the assistant is an overlay, so it starts closed.
  assistantOpen: window.innerWidth >= ASSISTANT_DOCK_MIN ? load("aura.assistantOpen", true) : false,
  sidebarOpen: false,
  sidebarW: clampWidth(load<unknown>("aura.sidebarW", null), SIDEBAR_W),
  assistantW: clampWidth(load<unknown>("aura.assistantW", null), ASSISTANT_W),
  chatText: load<ChatText>("aura.chatText", "md"),
  bubbleW: load<BubbleWidth>("aura.bubbleW", "normal"),
  paletteOpen: false,
  quickAdd: null,
  editingTaskId: null,
  focusTaskId: null,
  dialog: null,
  scheduling: null,
  editingEvent: null,
  assistantDraft: null,
  setView: (view, extra = {}) => {
    const projectId = extra.projectId !== undefined ? extra.projectId : view === "projects" ? get().projectId : null;
    const settingsSection = extra.settingsSection ?? get().settingsSection;
    set({ view, projectId, settingsSection, sidebarOpen: false });
    const params = new URLSearchParams();
    if (view === "projects" && projectId) params.set("project", projectId);
    if (view === "settings" && settingsSection !== "general") params.set("section", settingsSection);
    const hash = `#/${view}${params.toString() ? `?${params}` : ""}`;
    if (window.location.hash !== hash) window.history.pushState(null, "", hash);
  },
  set: (patch) => {
    if (patch.todayMode) save("aura.todayMode", patch.todayMode);
    if (patch.calendarMode) save("aura.calendarMode", patch.calendarMode);
    if (patch.assistantOpen !== undefined) save("aura.assistantOpen", patch.assistantOpen);
    if (patch.sidebarW !== undefined) save("aura.sidebarW", patch.sidebarW);
    if (patch.assistantW !== undefined) save("aura.assistantW", patch.assistantW);
    if (patch.chatText) save("aura.chatText", patch.chatText);
    if (patch.bubbleW) save("aura.bubbleW", patch.bubbleW);
    set(patch);
  },
  toggleAssistant: (open) => {
    const next = open ?? !get().assistantOpen;
    save("aura.assistantOpen", next);
    set({ assistantOpen: next });
  },
  askAssistant: (text, send = false) => {
    save("aura.assistantOpen", true);
    set({ assistantOpen: true, assistantDraft: { text, send } });
  },
}));
