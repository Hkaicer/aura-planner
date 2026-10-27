import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AiStatus, DayView, Proposal } from "../shared/api";
import { createApp, type AppHandle } from "../server/app";
import type { AIProvider } from "../server/ai/providers/types";
import { loadConfig } from "../server/config";
import { clockAt, TZ } from "./helpers";

const clock = clockAt("2026-10-26T07:30");

const offline: AIProvider = {
  id: "claude_code",
  billing: "subscription",
  async status(): Promise<AiStatus> {
    return {
      provider: "claude_code",
      state: "not_installed",
      billing: "subscription",
      message: "Claude Code is not installed.",
      detail: {},
      models: [],
      efforts: [],
      effortSupported: false,
      lastModel: null,
      rateLimit: null,
      apiKeyConfigured: false,
      apiConsent: false,
      apiService: null,
      chatgpt: null,
      checkedAt: new Date().toISOString(),
    };
  },
  async run() {
    const { ProviderError } = await import("../server/ai/providers/types");
    throw new ProviderError("not_installed", "Claude Code is not installed.", "install");
  },
};

const handles: AppHandle[] = [];
const dirs: string[] = [];

async function boot(dir?: string) {
  const dataDir = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "aura-test-"));
  if (!dir) dirs.push(dataDir);
  const h = await createApp({
    config: { ...loadConfig(), dataDir, webDir: path.join(dataDir, "no-web") },
    clock,
    providers: { claude_code: offline, anthropic_api: { ...offline, id: "anthropic_api", billing: "api" } },
  });
  if (!dir) {
    await h.app.inject({ method: "PATCH", url: "/api/settings", payload: { timeZone: TZ, workDays: [1, 2, 3, 4, 5, 6, 7], dayStart: "08:00", dayEnd: "22:00" } });
  }
  handles.push(h);
  return { h, dataDir };
}

afterEach(async () => {
  for (const h of handles.splice(0)) {
    await h.app.close();
    h.db.close();
  }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("HTTP API", () => {
  it("validates input on every write", async () => {
    const { h } = await boot();
    const bad = await h.app.inject({ method: "POST", url: "/api/tasks", payload: { title: "", estimateMin: 1 } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("validation");
    const missing = await h.app.inject({ method: "PATCH", url: "/api/tasks/t_nope", payload: { title: "x" } });
    expect(missing.statusCode).toBe(404);
  });

  it("acceptance C: completing a task is persisted and reflected in the day view", async () => {
    const { h } = await boot();
    const created = await h.app.inject({ method: "POST", url: "/api/tasks", payload: { title: "Project", plannedDate: "2026-10-26", estimateMin: 90 } });
    const id = created.json().result.id as string;
    const done = await h.app.inject({ method: "POST", url: `/api/tasks/${id}/complete`, payload: {} });
    expect(done.json().result.status).toBe("done");
    const day = (await h.app.inject({ method: "GET", url: "/api/day/2026-10-26" })).json() as DayView;
    expect(day.progress).toMatchObject({ total: 1, done: 1, pct: 100 });
  });

  it("plans a day without AI, previews it, applies it and undoes it", async () => {
    const { h } = await boot();
    await h.app.inject({ method: "POST", url: "/api/events", payload: { title: "Class", date: "2026-10-26", start: "09:00", end: "12:00" } });
    for (const [title, estimateMin] of [["Study", 120], ["Gym", 60]] as const) {
      await h.app.inject({ method: "POST", url: "/api/tasks", payload: { title, estimateMin, plannedDate: "2026-10-26" } });
    }
    const proposal = (await h.app.inject({ method: "POST", url: "/api/schedule/plan", payload: { date: "2026-10-26", mode: "full" } })).json() as Proposal;
    expect(proposal.status).toBe("pending");
    expect(proposal.preview?.plans[0]?.placements).toHaveLength(2);
    // Nothing written before approval.
    let day = (await h.app.inject({ method: "GET", url: "/api/day/2026-10-26" })).json() as DayView;
    expect(day.tasks.every((t) => t.scheduledStart === null)).toBe(true);

    const applied = (await h.app.inject({ method: "POST", url: `/api/proposals/${proposal.id}/apply`, payload: {} })).json() as Proposal;
    expect(applied.status).toBe("applied");
    day = (await h.app.inject({ method: "GET", url: "/api/day/2026-10-26" })).json() as DayView;
    expect(day.tasks.every((t) => t.scheduledStart !== null)).toBe(true);
    expect(day.analysis.conflicts).toEqual([]);

    const undo = await h.app.inject({ method: "POST", url: `/api/history/${applied.historyId}/undo` });
    expect(undo.statusCode).toBe(200);
    day = (await h.app.inject({ method: "GET", url: "/api/day/2026-10-26" })).json() as DayView;
    expect(day.tasks.every((t) => t.scheduledStart === null)).toBe(true);
  });

  it("acceptance E: data survives a restart", async () => {
    const { h, dataDir } = await boot();
    await h.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Thesis", deadline: "2026-12-01" } });
    const t = (await h.app.inject({ method: "POST", url: "/api/tasks", payload: { title: "Outline", scheduledStart: "2026-10-26T10:00", estimateMin: 45 } })).json().result;
    await h.app.inject({ method: "PATCH", url: "/api/settings", payload: { displayName: "Alex", dayEnd: "21:30" } });
    await h.app.close();
    h.db.close();
    handles.splice(handles.indexOf(h), 1);

    const { h: h2 } = await boot(dataDir);
    const tasks = (await h2.app.inject({ method: "GET", url: "/api/tasks" })).json() as { id: string; scheduledStart: string }[];
    expect(tasks.find((x) => x.id === t.id)?.scheduledStart).toBe("2026-10-26T10:00");
    const boot2 = (await h2.app.inject({ method: "GET", url: "/api/bootstrap" })).json();
    expect(boot2.projects.map((p: { name: string }) => p.name)).toEqual(["Thesis"]);
    expect(boot2.settings).toMatchObject({ displayName: "Alex", dayEnd: "21:30" });
    dirs.push(dataDir);
  });

  it("acceptance F: with Claude unavailable, the status is explicit and manual planning still works", async () => {
    const { h } = await boot();
    const status = (await h.app.inject({ method: "GET", url: "/api/ai/status" })).json() as AiStatus;
    expect(status.state).toBe("not_installed");
    const res = await h.app.inject({ method: "POST", url: "/api/ai/chat", payload: { message: "Plan my day" } });
    const lines = res.body.trim().split("\n").map((l) => JSON.parse(l));
    const err = lines.find((l) => l.type === "error");
    expect(err.message.meta.status).toBe("error");
    expect(err.message.content).toMatch(/not installed/);
    expect(lines.some((l) => l.type === "done")).toBe(false);
    const created = await h.app.inject({ method: "POST", url: "/api/tasks", payload: { title: "Manual", plannedDate: "2026-10-26" } });
    expect(created.statusCode).toBe(200);
    const plan = await h.app.inject({ method: "POST", url: "/api/schedule/plan", payload: { date: "2026-10-26" } });
    expect(plan.statusCode).toBe(200);
  });

  it("acceptance H: destructive actions need confirmation and deletions can be undone", async () => {
    const { h } = await boot();
    const t = (await h.app.inject({ method: "POST", url: "/api/tasks", payload: { title: "Important" } })).json().result;
    const del = (await h.app.inject({ method: "DELETE", url: `/api/tasks/${t.id}` })).json();
    expect(del.historyId).toBeTruthy();
    await h.app.inject({ method: "POST", url: `/api/history/${del.historyId}/undo` });
    const back = await h.app.inject({ method: "GET", url: `/api/tasks/${t.id}` });
    expect(back.statusCode).toBe(200);
    const noConfirm = await h.app.inject({ method: "POST", url: "/api/data/delete-all", payload: {} });
    expect(noConfirm.statusCode).toBe(400);
    const consent = await h.app.inject({ method: "POST", url: "/api/settings/api-consent", payload: { granted: true } });
    expect(consent.statusCode).toBe(400);
  });

  it("round-trips calendar files and JSON exports", async () => {
    const { h } = await boot();
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:1@test",
      "DTSTART;TZID=Europe/Paris:20261027T140000",
      "DTEND;TZID=Europe/Paris:20261027T170000",
      "SUMMARY:Lab session",
      "RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=3",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:2@test",
      "DTSTART:20261028T080000Z",
      "DTEND:20261028T090000Z",
      "SUMMARY:Dentist\\, downtown",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const imp = (await h.app.inject({ method: "POST", url: "/api/calendar/import", payload: { ics } })).json();
    expect(imp.imported).toBe(2);
    const events = (await h.app.inject({ method: "GET", url: "/api/events?from=2026-10-26&to=2026-11-15" })).json() as { title: string; start: string; occurrenceDate: string }[];
    expect(events.filter((e) => e.title === "Lab session").map((e) => e.occurrenceDate)).toEqual(["2026-10-27", "2026-11-03", "2026-11-10"]);
    expect(events.find((e) => e.title === "Dentist, downtown")?.start).toBe("09:00");
    const out = await h.app.inject({ method: "GET", url: "/api/calendar/export.ics" });
    expect(out.body).toContain("SUMMARY:Lab session");
    expect(out.body).toContain("RRULE:FREQ=WEEKLY");

    const exported = (await h.app.inject({ method: "GET", url: "/api/data/export" })).json();
    expect(exported.format).toBe("aura-export");
    const bad = await h.app.inject({ method: "POST", url: "/api/data/import", payload: { format: "nope" } });
    expect(bad.statusCode).toBe(400);
    const ok = await h.app.inject({ method: "POST", url: "/api/data/import", payload: exported });
    expect(ok.json().events).toBe(2);
  });

  it("rejects requests addressed to another host or sent from another website", async () => {
    const { h } = await boot();
    const rebinding = await h.app.inject({ method: "GET", url: "/api/tasks", headers: { host: "attacker.example:4317" } });
    expect(rebinding.statusCode).toBe(403);
    const crossSite = await h.app.inject({ method: "POST", url: "/api/tasks", headers: { origin: "https://attacker.example" }, payload: { title: "x" } });
    expect(crossSite.statusCode).toBe(403);
    const local = await h.app.inject({ method: "POST", url: "/api/tasks", headers: { origin: "http://127.0.0.1:4317" }, payload: { title: "Local" } });
    expect(local.statusCode).toBe(200);
  });

  it("serves the MCP endpoint only for an active run token", async () => {
    const { h } = await boot();
    const res = await h.app.inject({ method: "POST", url: "/mcp/not-a-token", payload: { jsonrpc: "2.0", id: 1, method: "tools/list" }, remoteAddress: "127.0.0.1" });
    expect(res.statusCode).toBe(404);
    const remote = await h.app.inject({ method: "POST", url: "/mcp/x", payload: { jsonrpc: "2.0", id: 1, method: "tools/list" }, remoteAddress: "10.0.0.5" });
    expect(remote.statusCode).toBe(403);
  });
});
