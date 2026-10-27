import fs from "node:fs";
import path from "node:path";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY = /key|token|secret|password|authorization|cookie|credential/i;
const SECRET_VALUE = /(sk-[a-z0-9-_]{16,}|Bearer\s+[A-Za-z0-9._-]+)/gi;
const MAX_BYTES = 2_000_000;

let threshold: Level = "info";
let file: string | null = null;
let quiet = false;

export function configureLogger(opts: { level?: Level; dir?: string; quiet?: boolean }) {
  if (opts.level) threshold = opts.level;
  if (opts.quiet !== undefined) quiet = opts.quiet;
  if (opts.dir) {
    fs.mkdirSync(opts.dir, { recursive: true });
    file = path.join(opts.dir, "aura.log");
  }
}

/** Remove secrets from structured log fields. Message content is never logged. */
function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (SECRET_KEY.test(k)) out[k] = "[redacted]";
    else if (typeof v === "string") out[k] = v.replace(SECRET_VALUE, "[redacted]");
    else out[k] = v;
  }
  return out;
}

function write(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  if (ORDER[level] < ORDER[threshold]) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg: msg.replace(SECRET_VALUE, "[redacted]"), ...redact(fields) });
  if (!quiet) (level === "error" ? console.error : console.log)(`[aura] ${level.padEnd(5)} ${msg}${Object.keys(fields).length ? " " + JSON.stringify(redact(fields)) : ""}`);
  if (file) {
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
      fs.appendFileSync(file, line + "\n");
    } catch {
      // logging must never break the app
    }
  }
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => write("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write("error", msg, fields),
};
