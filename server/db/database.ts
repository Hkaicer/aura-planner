import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { runMigrations } from "./migrations";

export type Row = Record<string, SQLInputValue>;

/**
 * Thin wrapper over node:sqlite with nested transactions (savepoints).
 * All writes in AURA go through `tx` so a failure never leaves partial data.
 */
export class Database {
  raw: DatabaseSync;
  private depth = 0;

  constructor(readonly file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = Database.open(file);
  }

  private static open(file: string): DatabaseSync {
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = 5000;");
    return db;
  }

  migrate() {
    return runMigrations(this);
  }

  exec(sql: string) {
    this.raw.exec(sql);
  }

  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: SQLInputValue[]) {
    return this.raw.prepare(sql).run(...params);
  }

  tx<T>(fn: () => T): T {
    const name = `sp_${this.depth}`;
    if (this.depth === 0) this.raw.exec("BEGIN IMMEDIATE");
    else this.raw.exec(`SAVEPOINT ${name}`);
    this.depth++;
    try {
      const result = fn();
      this.depth--;
      if (this.depth === 0) this.raw.exec("COMMIT");
      else this.raw.exec(`RELEASE ${name}`);
      return result;
    } catch (err) {
      this.depth--;
      if (this.depth === 0) this.raw.exec("ROLLBACK");
      else {
        this.raw.exec(`ROLLBACK TO ${name}`);
        this.raw.exec(`RELEASE ${name}`);
      }
      throw err;
    }
  }

  /** Consistent online copy of the database file. */
  backupTo(target: string) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const escaped = target.replace(/'/g, "''");
    this.raw.exec(`VACUUM INTO '${escaped}'`);
  }

  /** Replace the database file with another one and reopen it. */
  replaceWith(source: string) {
    if (this.file === ":memory:") throw new Error("Cannot restore an in-memory database");
    this.raw.close();
    for (const suffix of ["-wal", "-shm"]) {
      const f = this.file + suffix;
      if (fs.existsSync(f)) fs.rmSync(f);
    }
    fs.copyFileSync(source, this.file);
    this.raw = Database.open(this.file);
    this.migrate();
  }

  close() {
    this.raw.close();
  }
}
