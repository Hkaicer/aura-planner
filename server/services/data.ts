import fs from "node:fs";
import path from "node:path";
import type { Database } from "../db/database";
import { DomainError } from "../domain/context";

export { deleteAllData, exportAll, hasDemoData, importAll } from "./dataTransfer";

export interface BackupInfo {
  name: string;
  size: number;
  createdAt: string;
}

export function backupDir(dataDir: string) {
  return path.join(dataDir, "backups");
}

export function listBackups(dataDir: string): BackupInfo[] {
  const dir = backupDir(dataDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".db"))
    .map((name) => {
      const st = fs.statSync(path.join(dir, name));
      return { name, size: st.size, createdAt: st.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function createBackup(db: Database, dataDir: string, label = "manual"): BackupInfo {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
  const clean = label.replace(/[^a-z0-9-]/gi, "");
  let name = `aura-${stamp}-${clean}.db`;
  for (let i = 2; fs.existsSync(path.join(backupDir(dataDir), name)); i++) name = `aura-${stamp}-${clean}-${i}.db`;
  const target = path.join(backupDir(dataDir), name);
  db.backupTo(target);
  const keep = listBackups(dataDir);
  // Keep the 20 most recent automatic backups.
  for (const old of keep.filter((b) => !b.name.includes("-manual")).slice(20)) {
    fs.rmSync(path.join(backupDir(dataDir), old.name), { force: true });
  }
  const st = fs.statSync(target);
  return { name, size: st.size, createdAt: st.mtime.toISOString() };
}

export function restoreBackup(db: Database, dataDir: string, name: string): BackupInfo {
  if (!/^aura-[\w-]+\.db$/.test(name)) throw new DomainError("validation", "Invalid backup name.");
  const source = path.join(backupDir(dataDir), name);
  if (!fs.existsSync(source)) throw new DomainError("not_found", "This backup no longer exists.");
  const safety = createBackup(db, dataDir, "before-restore");
  db.replaceWith(source);
  return safety;
}
