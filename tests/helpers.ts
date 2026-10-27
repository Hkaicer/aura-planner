import { zSettings, type Settings } from "../shared/schemas";
import { zonedToInstant } from "../shared/time";
import { Database } from "../server/db/database";
import { DbStore } from "../server/db/store";
import type { DomainContext } from "../server/domain/context";
import type { EngineConfig, EngineTask, PlanInput } from "../server/scheduling/engine";
import { saveSettings } from "../server/services/settings";

export const TZ = "Europe/Paris";

export function testSettings(overrides: Partial<Settings> = {}): Settings {
  return zSettings.parse({
    timeZone: TZ,
    workDays: [1, 2, 3, 4, 5, 6, 7],
    dayStart: "08:00",
    dayEnd: "22:00",
    sleepStart: "23:30",
    sleepEnd: "07:00",
    ...overrides,
  });
}

/** A clock frozen at a local wall-clock time in the test time zone. */
export function clockAt(local: string): () => Date {
  const instant = zonedToInstant(local, TZ);
  return () => instant;
}

export function memoryDb(settings: Settings = testSettings()): Database {
  const db = new Database(":memory:");
  db.migrate();
  saveSettings(db, settings);
  return db;
}

export function dbCtx(db: Database, clock: () => Date, settings: Settings = testSettings()): DomainContext {
  return { store: new DbStore(db), settings, clock };
}

export function engineConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    bufferMin: 5,
    focusBlockMin: 90,
    breakMin: 15,
    lunch: { enabled: false, earliest: 12 * 60, latest: 14 * 60, durationMin: 45 },
    peak: { start: 8 * 60, end: 12 * 60 },
    strategy: "balanced",
    intensity: "normal",
    ...overrides,
  };
}

let seq = 0;
export function etask(over: Partial<EngineTask> & { title?: string } = {}): EngineTask {
  seq++;
  return {
    id: over.id ?? `t${seq}`,
    title: over.title ?? `Task ${seq}`,
    estimateMin: 60,
    priority: "medium",
    energy: "medium",
    status: "todo",
    dueAt: null,
    dueHard: true,
    dependsOn: [],
    pinned: false,
    scheduledStart: null,
    scheduledEnd: null,
    plannedDate: "2026-10-26",
    postponedCount: 0,
    projectDeadline: null,
    createdAt: `2026-10-20T08:00:${String(seq % 60).padStart(2, "0")}.000Z`,
    ...over,
  };
}

export function planInput(over: Partial<PlanInput> = {}): PlanInput {
  return {
    date: "2026-10-26",
    now: { date: "2026-10-25", minutes: 20 * 60 },
    window: { start: 8 * 60, end: 22 * 60 },
    blocks: [],
    tasks: [],
    dependencies: {},
    config: engineConfig(),
    mode: "full",
    ...over,
  };
}

export const hm = (s: string) => {
  const [h, m] = s.split(":").map(Number) as [number, number];
  return h * 60 + m;
};
