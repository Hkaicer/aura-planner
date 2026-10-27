import type { Database } from "./database";

export interface Migration {
  version: number;
  name: string;
  up: string;
}

// Append new migrations at the end; never edit one that has shipped.
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial schema",
    up: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        color TEXT NOT NULL,
        deadline TEXT,
        status TEXT NOT NULL CHECK (status IN ('active','archived')),
        is_demo INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        rev INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('inbox','todo','in_progress','done','cancelled')),
        priority TEXT NOT NULL CHECK (priority IN ('critical','high','medium','low')),
        estimate_min INTEGER NOT NULL CHECK (estimate_min BETWEEN 5 AND 720),
        actual_min INTEGER,
        start_date TEXT,
        due_at TEXT,
        due_hard INTEGER NOT NULL DEFAULT 1,
        planned_date TEXT,
        scheduled_start TEXT,
        scheduled_end TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        energy TEXT NOT NULL DEFAULT 'medium' CHECK (energy IN ('high','medium','low')),
        project_id TEXT,
        category TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        subtasks TEXT NOT NULL DEFAULT '[]',
        depends_on TEXT NOT NULL DEFAULT '[]',
        recurrence TEXT,
        recurrence_parent_id TEXT,
        notes TEXT NOT NULL DEFAULT '',
        links TEXT NOT NULL DEFAULT '[]',
        postponed_count INTEGER NOT NULL DEFAULT 0,
        position REAL NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'user',
        is_demo INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        rev INTEGER NOT NULL DEFAULT 1,
        CHECK (scheduled_end IS NULL OR scheduled_start IS NOT NULL)
      );
      CREATE INDEX idx_tasks_planned ON tasks(planned_date);
      CREATE INDEX idx_tasks_status ON tasks(status);
      CREATE INDEX idx_tasks_project ON tasks(project_id);
      CREATE INDEX idx_tasks_parent ON tasks(recurrence_parent_id);

      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        date TEXT NOT NULL,
        start TEXT NOT NULL,
        end TEXT NOT NULL,
        all_day INTEGER NOT NULL DEFAULT 0,
        kind TEXT NOT NULL CHECK (kind IN ('commitment','break','unavailable')),
        location TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        recurrence TEXT,
        source TEXT NOT NULL DEFAULT 'user',
        is_demo INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        rev INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX idx_events_date ON events(date);

      CREATE TABLE day_plans (
        date TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        rev INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE memory (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        rev INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
        content TEXT NOT NULL,
        meta TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_messages_created ON messages(created_at);

      CREATE TABLE proposals (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        source TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','applied','auto_applied','discarded','failed','undone')),
        summary TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        requires_approval INTEGER NOT NULL,
        changes TEXT NOT NULL,
        preview TEXT,
        history_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE TABLE history (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        source TEXT NOT NULL,
        changes TEXT NOT NULL,
        created_at TEXT NOT NULL,
        undone_at TEXT
      );
      CREATE INDEX idx_history_created ON history(created_at);

      CREATE TABLE time_entries (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL,
        minutes INTEGER NOT NULL CHECK (minutes >= 0),
        kind TEXT NOT NULL CHECK (kind IN ('focus','pomodoro','manual')),
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_time_entries_task ON time_entries(task_id);
    `,
  },
  {
    version: 2,
    name: "calendar feeds",
    up: `
      CREATE TABLE calendar_feeds (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        last_sync_at TEXT,
        last_error TEXT,
        event_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      ALTER TABLE events ADD COLUMN feed_id TEXT;
      ALTER TABLE events ADD COLUMN feed_uid TEXT;
      CREATE INDEX idx_events_feed ON events(feed_id);
    `,
  },
];

export interface MigrationStatus {
  current: number;
  latest: number;
  applied: { version: number; name: string; applied_at: string }[];
}

export function runMigrations(db: Database): MigrationStatus {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const current = db.get<{ v: number | null }>("SELECT MAX(version) AS v FROM schema_migrations")?.v ?? 0;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.tx(() => {
      db.exec(m.up);
      db.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)", m.version, m.name, new Date().toISOString());
    });
  }
  return migrationStatus(db);
}

export function migrationStatus(db: Database): MigrationStatus {
  const applied = db.all<{ version: number; name: string; applied_at: string }>(
    "SELECT version, name, applied_at FROM schema_migrations ORDER BY version",
  );
  return {
    current: applied.at(-1)?.version ?? 0,
    latest: MIGRATIONS.at(-1)?.version ?? 0,
    applied,
  };
}
