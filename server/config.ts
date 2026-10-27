import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const envFile = path.join(ROOT_DIR, ".env");
if (fs.existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // A malformed .env must not prevent the app from starting.
  }
}

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  webDir: string;
  logLevel: "debug" | "info" | "warn" | "error";
  seedDemo: boolean;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const dataDir = path.resolve(ROOT_DIR, process.env.AURA_DATA_DIR ?? "data");
  return {
    host: process.env.AURA_HOST ?? "127.0.0.1",
    port: int(process.env.AURA_PORT, 4317),
    dataDir,
    webDir: path.join(ROOT_DIR, "dist", "web"),
    logLevel: (process.env.AURA_LOG_LEVEL as AppConfig["logLevel"]) ?? "info",
    seedDemo: process.env.AURA_SEED_DEMO !== "false",
    ...overrides,
  };
}
