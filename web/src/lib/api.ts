import type {
  AiStatus,
  ApiService,
  Bootstrap,
  CalendarFeed,
  CalendarSyncResult,
  ChatMessage,
  ChatStreamEvent,
  DayView,
  HistoryEntry,
  Proposal,
  RangeDay,
  StatsSummary,
} from "@shared/api";
import type { CalEvent, EventOccurrence, MemoryNote, Project, Settings, SettingsPatch, Task, TaskCreate, TaskPatch } from "@shared/schemas";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const send: typeof fetch = (input, init) => fetch(input, init);

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await send(url, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : null,
    });
  } catch {
    throw new ApiError(0, "offline", "AURA's local server is not reachable. Is it still running?");
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? "error", err?.message ?? `Request failed (${res.status})`, err?.details);
  }
  return data as T;
}

export interface Mutation<T> {
  result: T;
  historyId: string | null;
}

export type ProjectWithStats = Project & { stats: { total: number; done: number; openMin: number; pct: number } };

export const api = {
  bootstrap: () => request<Bootstrap>("GET", "/api/bootstrap"),
  settings: () => request<Settings>("GET", "/api/settings"),
  patchSettings: (patch: SettingsPatch) => request<Settings>("PATCH", "/api/settings", patch),
  apiConsent: (granted: boolean) =>
    request<Settings>("POST", "/api/settings/api-consent", { granted, ...(granted ? { acknowledgement: "billed-separately" } : {}) }),
  onboarding: (body: { displayName: string; language: "en" | "fr"; dayStart?: string; dayEnd?: string; keepDemo: boolean }) =>
    request<Settings>("POST", "/api/onboarding", body),

  day: (date: string) => request<DayView>("GET", `/api/day/${date}`),
  range: (from: string, to: string) => request<RangeDay[]>("GET", `/api/range?from=${from}&to=${to}`),
  patchDayPlan: (date: string, patch: { dayStart?: string | null; dayEnd?: string | null; intensity?: "normal" | "light" }) =>
    request<Mutation<unknown>>("PATCH", `/api/day/${date}/plan`, patch),
  review: (date: string, body: { note: string; reasons: Record<string, string>; carryOver: { taskId: string; toDate: string }[] }) =>
    request<Mutation<unknown>>("POST", `/api/day/${date}/review`, body),

  tasks: (scope: "all" | "open" | "done" | "inbox" | "backlog" | "templates" = "all") => request<Task[]>("GET", `/api/tasks?scope=${scope}`),
  task: (id: string) => request<Task>("GET", `/api/tasks/${id}`),
  createTask: (body: TaskCreate) => request<Mutation<Task>>("POST", "/api/tasks", body),
  updateTask: (id: string, patch: TaskPatch) => request<Mutation<Task>>("PATCH", `/api/tasks/${id}`, patch),
  completeTask: (id: string, actualMin?: number | null) =>
    request<Mutation<Task>>("POST", `/api/tasks/${id}/complete`, actualMin !== undefined ? { actualMin } : {}),
  reopenTask: (id: string) => request<Mutation<Task>>("POST", `/api/tasks/${id}/reopen`, {}),
  startTask: (id: string) => request<Mutation<Task>>("POST", `/api/tasks/${id}/start`, {}),
  scheduleTask: (id: string, date: string, start: string, pin = true) =>
    request<Mutation<Task>>("POST", `/api/tasks/${id}/schedule`, { date, start, pin }),
  moveTask: (id: string, date: string, keepTime = false) => request<Mutation<Task>>("POST", `/api/tasks/${id}/move`, { date, keepTime }),
  unscheduleTask: (id: string, toBacklog = false) => request<Mutation<Task>>("POST", `/api/tasks/${id}/unschedule`, { toBacklog }),
  subtasks: (id: string, ops: { add?: string[]; toggle?: string[]; remove?: string[]; rename?: { id: string; title: string }[] }) =>
    request<Mutation<Task>>("POST", `/api/tasks/${id}/subtasks`, ops),
  deleteTask: (id: string) => request<Mutation<{ deleted: string }>>("DELETE", `/api/tasks/${id}`),
  reorder: (ids: string[]) => request<Mutation<void>>("POST", "/api/tasks/reorder", { ids }),
  postpone: (ids: string[], toDate: string) => request<Mutation<Task[]>>("POST", "/api/tasks/postpone", { ids, toDate }),
  logTime: (id: string, startedAt: string, endedAt: string, kind: "focus" | "pomodoro" | "manual") =>
    request<{ totalMinutes: number }>("POST", `/api/tasks/${id}/time`, { startedAt, endedAt, kind }),

  projects: () => request<ProjectWithStats[]>("GET", "/api/projects"),
  createProject: (body: { name: string; description?: string; color?: string; deadline?: string | null }) =>
    request<Mutation<Project>>("POST", "/api/projects", body),
  updateProject: (id: string, patch: Partial<Pick<Project, "name" | "description" | "color" | "deadline" | "status">>) =>
    request<Mutation<Project>>("PATCH", `/api/projects/${id}`, patch),
  deleteProject: (id: string, deleteTasks: boolean) => request<Mutation<unknown>>("DELETE", `/api/projects/${id}?deleteTasks=${deleteTasks}`),

  events: (from: string, to: string) => request<EventOccurrence[]>("GET", `/api/events?from=${from}&to=${to}`),
  createEvent: (body: Partial<CalEvent> & { title: string; date: string; start: string; end: string }) => request<Mutation<CalEvent>>("POST", "/api/events", body),
  updateEvent: (id: string, patch: Partial<CalEvent>) => request<Mutation<CalEvent>>("PATCH", `/api/events/${id}`, patch),
  deleteEvent: (id: string, occurrence?: string) =>
    request<Mutation<unknown>>("DELETE", `/api/events/${id}${occurrence ? `?occurrence=${occurrence}` : ""}`),

  plan: (date: string, mode: "full" | "preserve" | "reflow", intensity?: "normal" | "light") =>
    request<Proposal>("POST", "/api/schedule/plan", { date, mode, ...(intensity ? { intensity } : {}) }),
  freeTime: (from: string, to: string, min: number) =>
    request<{ date: string; start: string; end: string; minutes: number }[]>("GET", `/api/schedule/free?from=${from}&to=${to}&min=${min}`),

  proposal: (id: string) => request<Proposal>("GET", `/api/proposals/${id}`),
  applyProposal: (id: string, exclude: string[] = []) => request<Proposal>("POST", `/api/proposals/${id}/apply`, { exclude }),
  discardProposal: (id: string) => request<Proposal>("POST", `/api/proposals/${id}/discard`, {}),

  history: () => request<(Omit<HistoryEntry, "changes"> & { count: number })[]>("GET", "/api/history"),
  undo: (id: string) => request<{ undone: string; label: string }>("POST", `/api/history/${id}/undo`),
  undoLast: () => request<{ undone: string; label: string }>("POST", "/api/history/undo-last"),

  aiStatus: (force = false) => request<AiStatus>("GET", `/api/ai/status${force ? "?force=1" : ""}`),
  saveApiKey: (key: string, service?: ApiService) => request<{ service: ApiService; verified: boolean }>("POST", "/api/ai/key", { key, ...(service ? { service } : {}) }),
  removeApiKey: () => request<{ removed: boolean }>("DELETE", "/api/ai/key"),
  chatgptLogin: () => request<{ url: string }>("POST", "/api/chatgpt/login", {}),
  chatgptLogout: () => request<{ revoked: boolean }>("POST", "/api/chatgpt/logout", {}),
  chatgptModels: () => request<{ id: string; label: string }[]>("GET", "/api/chatgpt/models"),
  conversation: () => request<{ messages: ChatMessage[]; proposals: Proposal[]; busy: boolean }>("GET", "/api/ai/conversation"),
  clearConversation: () => request<{ cleared: boolean }>("DELETE", "/api/ai/conversation"),
  cancelChat: () => request<{ cancelled: boolean }>("POST", "/api/ai/cancel", {}),
  brief: (date: string) => request<{ text: string; model: string }>("POST", "/api/ai/brief", { date }),
  selfTest: () =>
    request<{ passed: boolean; stagedChanges: number; databaseUnchanged: boolean; results: { label: string; tool: string; rejected: boolean; error: string | null }[] }>(
      "POST",
      "/api/ai/self-test",
      {},
    ),

  contextPreview: () =>
    request<{ system: string; prompt: string; characters: number; tools: string[]; historyTurns: number }>("GET", "/api/ai/context-preview"),
  memory: () => request<MemoryNote[]>("GET", "/api/memory"),
  addMemory: (text: string) => request<Mutation<MemoryNote>>("POST", "/api/memory", { text }),
  deleteMemory: (id: string) => request<Mutation<unknown>>("DELETE", `/api/memory/${id}`),

  importIcs: (ics: string) => request<{ imported: number; duplicates: number; skipped: number; historyId: string | null }>("POST", "/api/calendar/import", { ics }),
  calendars: () => request<CalendarFeed[]>("GET", "/api/calendars"),
  addCalendar: (url: string) => request<CalendarSyncResult>("POST", "/api/calendars", { url }),
  refreshCalendar: (id: string) => request<CalendarSyncResult>("POST", `/api/calendars/${id}/refresh`, {}),
  removeCalendar: (id: string) => request<{ removed: number }>("DELETE", `/api/calendars/${id}`),
  importData: (data: unknown) => request<{ tasks: number; projects: number; events: number }>("POST", "/api/data/import", data),
  backups: () => request<{ name: string; size: number; createdAt: string }[]>("GET", "/api/data/backups"),
  createBackup: () => request<{ name: string }>("POST", "/api/data/backups", {}),
  restoreBackup: (name: string) => request<{ restored: string; safetyBackup: string }>("POST", `/api/data/backups/${encodeURIComponent(name)}/restore`, {}),
  clearDemo: () => request<Mutation<unknown>>("POST", "/api/data/clear-demo", {}),
  loadDemo: () => request<Mutation<unknown>>("POST", "/api/data/load-demo", {}),
  deleteAll: (backup: boolean) => request<{ deleted: boolean; backup: string | null }>("POST", "/api/data/delete-all", { confirm: "DELETE", backup }),

  stats: (days = 14) => request<StatsSummary>("GET", `/api/stats?days=${days}`),
};

/** Stream a chat request; resolves when the server closes the stream. */
export async function streamChat(
  body: { message: string; model?: "auto" | "sonnet" | "opus" | "haiku"; effort?: string; retryOf?: string },
  onEvent: (e: ChatStreamEvent | { type: "fatal"; message: string }) => void,
): Promise<void> {
  let res: Response;
  try {
    res = await send("/api/ai/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new ApiError(0, "offline", "AURA's local server is not reachable.");
  }
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(res.status, data?.error?.code ?? "error", data?.error?.message ?? "The request failed.");
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer.trim()));
}
