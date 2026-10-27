import path from "node:path";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { seedDemo } from "./db/seed";
import { DbStore } from "./db/store";
import { idleClock } from "./idleClock";
import { configureLogger, log } from "./logger";
import { fetchCalendar, refreshDueFeeds } from "./services/calendarFeeds";
import { createBackup } from "./services/data";
import { loadSettings, saveSettings } from "./services/settings";

const IDLE_TICK_MS = 30_000;

async function main() {
  const config = loadConfig();
  configureLogger({ level: config.logLevel, dir: path.join(config.dataDir, "logs") });
  if (!["127.0.0.1", "localhost", "::1"].includes(config.host) && process.env.AURA_ALLOW_NETWORK !== "I_UNDERSTAND_THE_RISK") {
    console.error(
      `[aura] Refusing to listen on ${config.host}: AURA has no login and is meant for this computer only. Use AURA_HOST=127.0.0.1.`,
    );
    process.exit(1);
  }
  const { app, db, agent } = await createApp({ config });

  // When started by the app shortcut, stop after a while without any request
  // (the open window sends a heartbeat every minute, even when minimized).
  // Time the computer spends asleep does not count.
  const idleMinutes = process.env.AURA_LAUNCHED_BY === "app" ? Number(process.env.AURA_IDLE_EXIT_MIN ?? 20) : 0;
  const idle = idleClock(2 * IDLE_TICK_MS);
  if (idleMinutes > 0) {
    app.addHook("onRequest", async () => {
      idle.reset();
    });
  }

  // First launch: store detected defaults and load the removable example data.
  const hasSettings = db.get("SELECT 1 AS x FROM settings WHERE id = 1");
  if (!hasSettings) {
    const settings = saveSettings(db, loadSettings(db));
    const empty = Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks")?.n ?? 0) === 0;
    if (config.seedDemo && empty) {
      db.tx(() => seedDemo(new DbStore(db), settings));
      log.info("example data loaded");
    }
  } else {
    // Daily safety copy on startup.
    try {
      createBackup(db, config.dataDir, "auto");
    } catch (err) {
      log.warn("startup backup failed", { error: (err as Error).message });
    }
  }

  await app.listen({ host: config.host, port: config.port });
  log.info(`AURA is running at http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}`);

  const shutdown = async () => {
    log.info("shutting down");
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Calendars added by link: downloaded again once they are a few hours old, checked now and every hour.
  const refreshFeeds = () =>
    void refreshDueFeeds(db, fetchCalendar, () => new Date()).catch((err) => log.warn("calendar refresh failed", { error: (err as Error).message }));
  refreshFeeds();
  setInterval(refreshFeeds, 60 * 60_000).unref();

  if (idleMinutes > 0) {
    log.info(`will stop after ${idleMinutes} min without activity`);
    const timer = setInterval(() => {
      if (idle.tick() > idleMinutes * 60_000 && !agent.busy) {
        clearInterval(timer);
        log.info("no activity, stopping");
        void shutdown();
      }
    }, IDLE_TICK_MS);
    timer.unref();
  }
}

main().catch((err) => {
  const e = err as NodeJS.ErrnoException;
  if (e.code === "EADDRINUSE") {
    console.error("[aura] The port is already in use. AURA may already be running; open http://127.0.0.1:4317 or set AURA_PORT in .env.");
  } else {
    console.error("[aura] failed to start:", e.message);
  }
  process.exit(1);
});
