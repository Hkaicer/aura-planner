import { z } from "zod";
import { isValidDate, isValidDateTime, isValidTimeZone, TIME_RE } from "./time";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const PRIORITIES = ["critical", "high", "medium", "low"] as const;
export const TASK_STATUSES = ["inbox", "todo", "in_progress", "done", "cancelled"] as const;
export const ENERGY_LEVELS = ["high", "medium", "low"] as const;
export const EVENT_KINDS = ["commitment", "break", "unavailable"] as const;
export const INTENSITIES = ["normal", "light"] as const;
export const PLAN_MODES = ["full", "preserve", "reflow"] as const;

export const zDate = z.string().refine(isValidDate, { message: "Expected a date as YYYY-MM-DD" });
export const zTime = z.string().regex(TIME_RE, { message: "Expected a time as HH:mm (24h)" });
export const zDateTime = z.string().refine(isValidDateTime, { message: "Expected a date-time as YYYY-MM-DDTHH:mm" });
export const zPriority = z.enum(PRIORITIES);
export const zStatus = z.enum(TASK_STATUSES);
export const zEnergy = z.enum(ENERGY_LEVELS);
export const zEventKind = z.enum(EVENT_KINDS);
export const zIntensity = z.enum(INTENSITIES);
export const zPlanMode = z.enum(PLAN_MODES);
export const zId = z.string().min(1).max(80);

export type Priority = z.infer<typeof zPriority>;
export type TaskStatus = z.infer<typeof zStatus>;
export type Energy = z.infer<typeof zEnergy>;
export type EventKind = z.infer<typeof zEventKind>;
export type Intensity = z.infer<typeof zIntensity>;
export type PlanMode = z.infer<typeof zPlanMode>;

export const zRecurrence = z.object({
  freq: z.enum(["daily", "weekly", "monthly"]),
  interval: z.number().int().min(1).max(30).default(1),
  /** ISO weekdays, 1 = Monday ... 7 = Sunday (weekly only). */
  byWeekday: z.array(z.number().int().min(1).max(7)).max(7).optional(),
  until: zDate.nullable().optional(),
  /** Preferred start time for generated instances; instances are pinned when set. */
  time: zTime.nullable().optional(),
  /** Occurrence dates that were deleted and must not be regenerated. */
  exDates: z.array(zDate).default([]),
});
export type Recurrence = z.infer<typeof zRecurrence>;

export const zSubtask = z.object({
  id: zId,
  title: z.string().min(1).max(200),
  done: z.boolean(),
});
export type Subtask = z.infer<typeof zSubtask>;

export const zLink = z.object({
  url: z.string().url().max(2000),
  label: z.string().max(200).optional(),
});
export type Link = z.infer<typeof zLink>;

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  estimateMin: number;
  actualMin: number | null;
  /** Earliest date the task may be worked on. */
  startDate: string | null;
  dueAt: string | null;
  dueHard: boolean;
  /** Day the task is planned for; null keeps it in the flexible backlog. */
  plannedDate: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  /** Pinned tasks keep their time; the scheduler never moves them. */
  pinned: boolean;
  energy: Energy;
  projectId: string | null;
  category: string | null;
  tags: string[];
  subtasks: Subtask[];
  dependsOn: string[];
  recurrence: Recurrence | null;
  recurrenceParentId: string | null;
  notes: string;
  links: Link[];
  postponedCount: number;
  position: number;
  source: "user" | "ai" | "demo" | "recurrence" | "ics";
  isDemo: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  rev: number;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  color: string;
  deadline: string | null;
  status: "active" | "archived";
  isDemo: boolean;
  createdAt: string;
  updatedAt: string;
  rev: number;
}

export interface CalEvent {
  id: string;
  title: string;
  date: string;
  start: string;
  end: string;
  allDay: boolean;
  kind: EventKind;
  location: string;
  notes: string;
  recurrence: Recurrence | null;
  source: "user" | "ai" | "ics" | "demo";
  isDemo: boolean;
  /** The subscribed calendar this event comes from (kept up to date by it), and its id there. */
  feedId: string | null;
  feedUid: string | null;
  createdAt: string;
  updatedAt: string;
  rev: number;
}

/** A single dated occurrence of an event (recurring events are expanded). */
export interface EventOccurrence extends CalEvent {
  occurrenceDate: string;
  seriesId: string;
}

export interface DayReview {
  reviewedAt: string;
  note: string;
  reasons: Record<string, string>;
}

export interface DayPlan {
  date: string;
  dayStart: string | null;
  dayEnd: string | null;
  intensity: Intensity;
  /** Breaks and lunch placed by the scheduler when a plan was accepted. */
  breaks: { start: string; end: string; label: string }[];
  acceptedAt: string | null;
  aiBrief: { text: string; model: string; createdAt: string } | null;
  review: DayReview | null;
  updatedAt: string;
  rev: number;
}

export interface MemoryNote {
  id: string;
  text: string;
  source: "user" | "ai";
  createdAt: string;
  updatedAt: string;
  rev: number;
}

export type EntityName = "task" | "project" | "event" | "dayPlan" | "memory";

export interface EntityMap {
  task: Task;
  project: Project;
  event: CalEvent;
  dayPlan: DayPlan;
  memory: MemoryNote;
}

export interface Change<E extends EntityName = EntityName> {
  entity: E;
  id: string;
  op: "create" | "update" | "delete";
  before: EntityMap[E] | null;
  after: EntityMap[E] | null;
}

export interface HistoryEntry {
  id: string;
  label: string;
  source: "user" | "ai" | "engine" | "system";
  changes: Change[];
  createdAt: string;
  undoneAt: string | null;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const zUnavailable = z.object({
  id: zId,
  label: z.string().max(80),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1),
  start: zTime,
  end: zTime,
});

export const EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export const zEffort = z.enum(EFFORTS);
export type Effort = z.infer<typeof zEffort>;

export const zSettings = z.object({
  displayName: z.string().max(60).default(""),
  language: z.enum(["en", "fr"]).default("en"),
  theme: z.enum(["system", "light", "dark"]).default("system"),
  timeZone: z.string().refine(isValidTimeZone, { message: "Unknown time zone" }).default("UTC"),
  workDays: z.array(z.number().int().min(1).max(7)).default([1, 2, 3, 4, 5]),
  dayStart: zTime.default("08:30"),
  dayEnd: zTime.default("22:00"),
  weekendPlanning: z.boolean().default(true),
  weekendStart: zTime.default("10:00"),
  weekendEnd: zTime.default("21:00"),
  sleepStart: zTime.default("23:30"),
  sleepEnd: zTime.default("07:30"),
  defaultEstimateMin: z.number().int().min(5).max(480).default(30),
  focusBlockMin: z.number().int().min(25).max(240).default(90),
  breakMin: z.number().int().min(0).max(60).default(15),
  bufferMin: z.number().int().min(0).max(30).default(5),
  lunch: z
    .object({
      enabled: z.boolean().default(true),
      earliest: zTime.default("12:00"),
      latest: zTime.default("14:00"),
      durationMin: z.number().int().min(15).max(120).default(45),
    })
    .default({ enabled: true, earliest: "12:00", latest: "14:00", durationMin: 45 }),
  peakEnergy: z.enum(["morning", "afternoon", "evening"]).default("morning"),
  strategy: z.enum(["balanced", "deadline_first", "priority_first"]).default("balanced"),
  unavailable: z.array(zUnavailable).default([]),
  notifications: z
    .object({ enabled: z.boolean().default(false), minutesBefore: z.number().int().min(0).max(60).default(5) })
    .default({ enabled: false, minutesBefore: 5 }),
  ai: z
    .object({
      provider: z.enum(["claude_code", "anthropic_api", "chatgpt", "off"]).default("claude_code"),
      modelMode: z.enum(["auto", "sonnet", "opus", "haiku", "custom"]).default("auto"),
      customModel: z.string().max(80).default(""),
      /** The ChatGPT model to use; empty means the first one the account offers. */
      chatgptModel: z.string().max(100).default(""),
      effortSimple: zEffort.default("low"),
      effortModerate: zEffort.default("medium"),
      effortComplex: zEffort.default("high"),
      opusEscalation: z.boolean().default(true),
      opusEffort: zEffort.default("medium"),
      autoApply: z.enum(["minor", "never"]).default("minor"),
      claudePath: z.string().max(500).default(""),
      /** Explicit, recorded consent to separately billed Anthropic API usage. */
      apiBillingConsentAt: z.string().nullable().default(null),
      timeoutSec: z.number().int().min(30).max(900).default(240),
      historyTurns: z.number().int().min(2).max(40).default(12),
    })
    .default({
      provider: "claude_code",
      modelMode: "auto",
      customModel: "",
      chatgptModel: "",
      effortSimple: "low",
      effortModerate: "medium",
      effortComplex: "high",
      opusEscalation: true,
      opusEffort: "medium",
      autoApply: "minor",
      claudePath: "",
      apiBillingConsentAt: null,
      timeoutSec: 240,
      historyTurns: 12,
    }),
  onboarded: z.boolean().default(false),
});
export type Settings = z.infer<typeof zSettings>;

export const zSettingsPatch = zSettings.partial().extend({
  lunch: zSettings.shape.lunch.unwrap().partial().optional(),
  notifications: zSettings.shape.notifications.unwrap().partial().optional(),
  ai: zSettings.shape.ai.unwrap().omit({ apiBillingConsentAt: true }).partial().optional(),
});
export type SettingsPatch = z.infer<typeof zSettingsPatch>;

// ---------------------------------------------------------------------------
// API inputs (validated on every write)
// ---------------------------------------------------------------------------

const title = z.string().trim().min(1, "Title is required").max(200);

export const zTaskCreate = z.object({
  title,
  description: z.string().max(4000).optional(),
  status: zStatus.optional(),
  priority: zPriority.optional(),
  estimateMin: z.number().int().min(5).max(720).optional(),
  startDate: zDate.nullable().optional(),
  dueAt: zDateTime.nullable().optional(),
  dueHard: z.boolean().optional(),
  plannedDate: zDate.nullable().optional(),
  scheduledStart: zDateTime.nullable().optional(),
  pinned: z.boolean().optional(),
  energy: zEnergy.optional(),
  projectId: zId.nullable().optional(),
  category: z.string().max(60).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  subtasks: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  dependsOn: z.array(zId).max(20).optional(),
  recurrence: zRecurrence.nullable().optional(),
  notes: z.string().max(10000).optional(),
  links: z.array(zLink).max(20).optional(),
});
export type TaskCreate = z.infer<typeof zTaskCreate>;

export const zTaskPatch = z.object({
  title: title.optional(),
  description: z.string().max(4000).optional(),
  status: zStatus.optional(),
  priority: zPriority.optional(),
  estimateMin: z.number().int().min(5).max(720).optional(),
  actualMin: z.number().int().min(0).max(1440).nullable().optional(),
  startDate: zDate.nullable().optional(),
  dueAt: zDateTime.nullable().optional(),
  dueHard: z.boolean().optional(),
  plannedDate: zDate.nullable().optional(),
  scheduledStart: zDateTime.nullable().optional(),
  scheduledEnd: zDateTime.nullable().optional(),
  pinned: z.boolean().optional(),
  energy: zEnergy.optional(),
  projectId: zId.nullable().optional(),
  category: z.string().max(60).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  subtasks: z.array(zSubtask).max(50).optional(),
  dependsOn: z.array(zId).max(20).optional(),
  recurrence: zRecurrence.nullable().optional(),
  notes: z.string().max(10000).optional(),
  links: z.array(zLink).max(20).optional(),
  position: z.number().optional(),
});
export type TaskPatch = z.infer<typeof zTaskPatch>;

export const zProjectCreate = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(2000).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  deadline: zDate.nullable().optional(),
});
export const zProjectPatch = zProjectCreate.partial().extend({ status: z.enum(["active", "archived"]).optional() });

const eventBase = z.object({
  title,
  date: zDate,
  start: zTime,
  end: zTime,
  allDay: z.boolean().optional(),
  kind: zEventKind.optional(),
  location: z.string().max(200).optional(),
  notes: z.string().max(4000).optional(),
  recurrence: zRecurrence.nullable().optional(),
});
export const zEventCreate = eventBase.refine((e) => e.allDay || e.end > e.start, {
  message: "Event end must be after its start",
  path: ["end"],
});
export const zEventPatch = eventBase.partial();

export const zDayPlanPatch = z.object({
  dayStart: zTime.nullable().optional(),
  dayEnd: zTime.nullable().optional(),
  intensity: zIntensity.optional(),
});

export const zPlanRequest = z.object({
  date: zDate,
  mode: zPlanMode.default("full"),
  intensity: zIntensity.optional(),
  blockFromNowMin: z.number().int().min(0).max(600).optional(),
});

export const zReorder = z.object({ ids: z.array(zId).min(1).max(500) });

// ---------------------------------------------------------------------------
// Entity validators (used to validate imports and restored data)
// ---------------------------------------------------------------------------

const zIso = z.string().min(10).max(40);

export const zTaskEntity = z.object({
  id: zId,
  title: z.string().min(1).max(200),
  description: z.string().max(4000),
  status: zStatus,
  priority: zPriority,
  estimateMin: z.number().int().min(5).max(720),
  actualMin: z.number().int().min(0).max(1440).nullable(),
  startDate: zDate.nullable(),
  dueAt: zDateTime.nullable(),
  dueHard: z.boolean(),
  plannedDate: zDate.nullable(),
  scheduledStart: zDateTime.nullable(),
  scheduledEnd: zDateTime.nullable(),
  pinned: z.boolean(),
  energy: zEnergy,
  projectId: zId.nullable(),
  category: z.string().max(60).nullable(),
  tags: z.array(z.string().max(40)).max(20),
  subtasks: z.array(zSubtask).max(50),
  dependsOn: z.array(zId).max(20),
  recurrence: zRecurrence.nullable(),
  recurrenceParentId: zId.nullable(),
  notes: z.string().max(10000),
  links: z.array(zLink).max(20),
  postponedCount: z.number().int().min(0),
  position: z.number(),
  source: z.enum(["user", "ai", "demo", "recurrence", "ics"]),
  isDemo: z.boolean(),
  createdAt: zIso,
  updatedAt: zIso,
  completedAt: zIso.nullable(),
  rev: z.number().int().min(0),
});

export const zProjectEntity = z.object({
  id: zId,
  name: z.string().min(1).max(80),
  description: z.string().max(2000),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  deadline: zDate.nullable(),
  status: z.enum(["active", "archived"]),
  isDemo: z.boolean(),
  createdAt: zIso,
  updatedAt: zIso,
  rev: z.number().int().min(0),
});

export const zEventEntity = z.object({
  id: zId,
  title: z.string().min(1).max(200),
  date: zDate,
  start: zTime,
  end: zTime,
  allDay: z.boolean(),
  kind: zEventKind,
  location: z.string().max(200),
  notes: z.string().max(4000),
  recurrence: zRecurrence.nullable(),
  source: z.enum(["user", "ai", "ics", "demo"]),
  isDemo: z.boolean(),
  feedId: z.string().max(80).nullable().default(null),
  feedUid: z.string().max(1000).nullable().default(null),
  createdAt: zIso,
  updatedAt: zIso,
  rev: z.number().int().min(0),
});

export const zDayPlanEntity = z.object({
  date: zDate,
  dayStart: zTime.nullable(),
  dayEnd: zTime.nullable(),
  intensity: zIntensity,
  breaks: z.array(z.object({ start: zTime, end: zTime, label: z.string().max(40) })).default([]),
  acceptedAt: zIso.nullable(),
  aiBrief: z.object({ text: z.string().max(4000), model: z.string().max(80), createdAt: zIso }).nullable(),
  review: z
    .object({ reviewedAt: zIso, note: z.string().max(4000), reasons: z.record(z.string(), z.string().max(500)) })
    .nullable(),
  updatedAt: zIso,
  rev: z.number().int().min(0),
});

export const zMemoryEntity = z.object({
  id: zId,
  text: z.string().min(1).max(400),
  source: z.enum(["user", "ai"]),
  createdAt: zIso,
  updatedAt: zIso,
  rev: z.number().int().min(0),
});

export const zExportFile = z.object({
  format: z.literal("aura-export"),
  version: z.literal(1),
  exportedAt: z.string(),
  settings: z.unknown(),
  projects: z.array(zProjectEntity),
  tasks: z.array(zTaskEntity),
  events: z.array(zEventEntity),
  dayPlans: z.array(zDayPlanEntity),
  memory: z.array(zMemoryEntity),
});
export type ExportFile = z.infer<typeof zExportFile>;
