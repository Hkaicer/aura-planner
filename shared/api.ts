// Response shapes shared by the API server and the web client.
import type { Change, DayPlan, EventOccurrence, HistoryEntry, MemoryNote, Project, Settings, Task } from "./schemas";

export interface ScorePart {
  key: "priority" | "deadline" | "overdue" | "postponed" | "project_deadline";
  value: number;
  detail?: string;
}
export interface TaskScore {
  total: number;
  parts: ScorePart[];
}

export type DayStatus = "ok" | "tight" | "overloaded" | "past" | "empty";

export interface Conflict {
  kind: "overlap" | "after_deadline" | "before_dependency" | "outside_window" | "missed";
  taskId: string;
  otherId?: string;
  message: string;
}

export interface DayAnalysis {
  conflicts: Conflict[];
  availableMin: number;
  remainingDemandMin: number;
  scheduledRemainingMin: number;
  unscheduledMin: number;
  overloadMin: number;
  status: DayStatus;
}

export interface DayView {
  date: string;
  today: string;
  now: string;
  window: { start: string; end: string; isWorkDay: boolean; source: "work" | "weekend" | "override" | "off" };
  plan: DayPlan;
  events: EventOccurrence[];
  tasks: Task[];
  overdue: Task[];
  analysis: DayAnalysis;
  progress: { total: number; done: number; pct: number; plannedMin: number; doneMin: number; actualMin: number };
  scores: Record<string, TaskScore>;
  streak: number;
}

export interface Placement {
  taskId: string;
  title: string;
  start: number;
  end: number;
  score: number;
  moved: boolean;
  previousStart: number | null;
  reasons: string[];
}

export interface Overflow {
  taskId: string;
  title: string;
  reason: "no_time" | "deadline" | "blocked" | "light_day";
  detail: string;
  estimateMin: number;
  score: number;
  suggestedDate?: string | null;
}

export interface PlanResult {
  date: string;
  mode: "full" | "preserve" | "reflow";
  effectiveStart: number;
  placements: Placement[];
  overflow: Overflow[];
  breaks: { start: number; end: number; label: string }[];
  lunch: { start: number; end: number } | null;
  stats: {
    windowMin: number;
    availableMin: number;
    scheduledMin: number;
    breakMin: number;
    freeMin: number;
    demandMin: number;
    overloadMin: number;
    status: DayStatus;
  };
  explanation: string[];
  warnings: string[];
}

export interface ChangeSummary {
  key: string;
  entity: Change["entity"];
  op: Change["op"];
  title: string;
  kind: "created" | "deleted" | "completed" | "reopened" | "scheduled" | "unscheduled" | "moved" | "updated";
  details: string[];
}

export type ProposalStatus = "pending" | "applied" | "auto_applied" | "discarded" | "failed" | "undone";

export interface Proposal {
  id: string;
  messageId: string | null;
  source: "ai" | "engine";
  status: ProposalStatus;
  summary: string;
  reason: string;
  requiresApproval: boolean;
  changes: Change[];
  items: ChangeSummary[];
  preview: { plans: PlanResult[] } | null;
  historyId: string | null;
  error: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export type ComplexityLevel = "simple" | "moderate" | "complex";

export interface RoutingDecision {
  level: ComplexityLevel;
  score: number;
  signals: string[];
  model: string;
  modelLabel: string;
  effort: string | null;
  auto: boolean;
  escalated: boolean;
  reason: string;
}

export interface MessageMeta {
  status?: "ok" | "error";
  error?: { code: string; message: string; suggestion?: "switch_to_api" | "login" | "install" | "retry" | "settings" };
  provider?: "claude_code" | "anthropic_api" | "chatgpt";
  billing?: "subscription" | "api";
  model?: string;
  effort?: string | null;
  effortApplied?: boolean;
  routing?: RoutingDecision;
  proposalId?: string;
  toolCalls?: { name: string; ok: boolean; error?: string }[];
  durationMs?: number;
  usage?: { inputTokens: number; outputTokens: number; costUsd: number | null };
  retryOf?: string;
  kind?: "brief" | "chat";
  /** Answered by AURA itself, without the AI (adding a calendar link). */
  local?: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  meta: MessageMeta;
  createdAt: string;
}

export interface Conversation {
  messages: ChatMessage[];
  proposals: Proposal[];
}

export interface RateWindow {
  utilization: number;
  resetsAt: number;
}

/** The services an API key saved in Settings can belong to, recognized from the key. */
export type ApiService = "anthropic" | "deepseek";

/** What a pasted key looks like: a service, a Claude subscription token (refused) or unknown. */
export type KeyDetection = ApiService | "subscription_token" | "unknown";

/** The ChatGPT account AURA is signed in to (never the tokens themselves). */
export interface ChatGptAccount {
  email: string | null;
  /** Whether the user allowed AURA to use their ChatGPT plan during sign-in. */
  planUsage: boolean;
}

export interface AiStatus {
  provider: "claude_code" | "anthropic_api" | "chatgpt" | "off";
  state: "ready" | "not_installed" | "not_logged_in" | "api_key_auth" | "needs_consent" | "missing_key" | "disabled" | "error" | "checking";
  billing: "subscription" | "api" | "none";
  message: string;
  detail: Record<string, string | number | boolean | null>;
  models: { id: string; label: string; family: "sonnet" | "opus" | "haiku" | "other" }[];
  efforts: string[];
  effortSupported: boolean;
  lastModel: string | null;
  rateLimit: { fiveHour: RateWindow | null; sevenDay: RateWindow | null; status: string | null; updatedAt: string | null } | null;
  apiKeyConfigured: boolean;
  apiConsent: boolean;
  /** The service of the API key saved in Settings, whichever provider is in use. */
  apiService: ApiService | null;
  /** The ChatGPT account, when AURA is signed in to one. */
  chatgpt: ChatGptAccount | null;
  checkedAt: string;
}

/** A calendar added by link (iCal or webcal), downloaded again every few hours. */
export interface CalendarFeed {
  id: string;
  name: string;
  /** Host of the link only: the full link holds a private key and stays on the device. */
  host: string;
  lastSyncAt: string | null;
  lastError: string | null;
  eventCount: number;
  createdAt: string;
}

export interface CalendarSyncResult {
  feed: CalendarFeed;
  added: number;
  updated: number;
  removed: number;
  /** Events from today on. */
  upcoming: number;
  /** False when the link had already been added (it was refreshed). */
  created: boolean;
}

export type ChatStreamEvent =
  | { type: "accepted"; userMessage: ChatMessage; routing: RoutingDecision | null }
  | { type: "status"; text: string }
  | { type: "tool"; name: string; ok: boolean; error?: string }
  | { type: "text"; delta: string }
  | { type: "done"; message: ChatMessage; proposal: Proposal | null }
  | { type: "error"; message: ChatMessage };

export interface RangeDay {
  date: string;
  window: { start: string; end: string; isWorkDay: boolean };
  events: EventOccurrence[];
  tasks: Task[];
  analysis: DayAnalysis;
  plan: DayPlan;
}

export interface Bootstrap {
  settings: Settings;
  projects: Project[];
  memory: MemoryNote[];
  version: string;
  systemTimeZone: string;
  hasDemoData: boolean;
  dataDir: string;
}

export interface StatsSummary {
  days: { date: string; completed: number; plannedMin: number; actualMin: number; focusMin: number }[];
  completedThisWeek: number;
  focusMinutesThisWeek: number;
  estimateAccuracy: number | null;
  streak: number;
}

export type { HistoryEntry };
