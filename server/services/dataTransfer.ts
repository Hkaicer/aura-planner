import { zExportFile, zSettings, type ExportFile } from "../../shared/schemas";
import type { Database } from "../db/database";
import { DbStore } from "../db/store";
import { DomainError } from "../domain/context";
import { loadSettings, saveSettings } from "./settings";

// Export, import and deletion work on the database alone. Backups (files on
// disk) live in data.ts.

export function exportAll(db: Database): ExportFile {
  const store = new DbStore(db);
  return {
    format: "aura-export",
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: loadSettings(db),
    projects: store.all("project"),
    tasks: store.all("task"),
    events: store.all("event"),
    dayPlans: store.all("dayPlan"),
    memory: store.all("memory"),
  };
}

const DATA_TABLES = ["tasks", "projects", "events", "day_plans", "memory", "history", "proposals", "time_entries"];

/** Replace all planning data with the content of an export file (validated first). */
export function importAll(db: Database, raw: unknown): { tasks: number; projects: number; events: number } {
  const parsed = zExportFile.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new DomainError("validation", `This file is not a valid AURA export (${first}).`);
  }
  const data = parsed.data;
  const settings = zSettings.safeParse(data.settings);
  db.tx(() => {
    for (const t of DATA_TABLES) db.run(`DELETE FROM ${t}`);
    const store = new DbStore(db);
    for (const p of data.projects) store.put("project", p);
    for (const t of data.tasks) store.put("task", t);
    for (const e of data.events) store.put("event", e);
    for (const d of data.dayPlans) store.put("dayPlan", d);
    for (const m of data.memory) store.put("memory", m);
    if (settings.success) saveSettings(db, settings.data);
  });
  return { tasks: data.tasks.length, projects: data.projects.length, events: data.events.length };
}

export function deleteAllData(db: Database) {
  db.tx(() => {
    for (const t of [...DATA_TABLES, "calendar_feeds", "messages", "settings"]) db.run(`DELETE FROM ${t}`);
  });
}

export function hasDemoData(db: Database): boolean {
  const n = (sql: string) => Number(db.get<{ n: number }>(sql)?.n ?? 0);
  return n("SELECT COUNT(*) AS n FROM tasks WHERE is_demo = 1") + n("SELECT COUNT(*) AS n FROM events WHERE is_demo = 1") + n("SELECT COUNT(*) AS n FROM projects WHERE is_demo = 1") > 0;
}
