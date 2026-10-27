// Database maintenance commands: `npm run db:migrate`, `npm run db:status`.
import path from "node:path";
import { loadConfig } from "../config";
import { Database } from "./database";
import { migrationStatus, MIGRATIONS } from "./migrations";

const command = process.argv[2] ?? "status";
const config = loadConfig();
const file = path.join(config.dataDir, "aura.db");
const db = new Database(file);

if (command === "migrate") {
  const status = db.migrate();
  console.log(`Database ${file} is at schema version ${status.current} (latest ${status.latest}).`);
} else if (command === "status") {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const status = migrationStatus(db);
  console.log(`Database: ${file}`);
  console.log(`Schema version: ${status.current} / ${status.latest}`);
  for (const m of MIGRATIONS) {
    const applied = status.applied.find((a) => a.version === m.version);
    console.log(`  ${applied ? "applied" : "pending"}  v${m.version}  ${m.name}${applied ? `  (${applied.applied_at})` : ""}`);
  }
} else {
  console.error(`Unknown command "${command}". Use "migrate" or "status".`);
  process.exitCode = 1;
}
db.close();
