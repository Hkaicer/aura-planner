import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiService, Bootstrap, ChatStreamEvent, RangeDay, StatsSummary } from "../../shared/api";
import { detectService, looksLikeApiKey } from "../../shared/apiKeys";
import {
  zDate,
  zDayPlanPatch,
  zEffort,
  zEventCreate,
  zEventPatch,
  zPlanRequest,
  zProjectCreate,
  zProjectPatch,
  zReorder,
  zSettingsPatch,
  zTaskCreate,
  zTaskPatch,
  zExportFile,
  zTime,
  type SettingsPatch,
  type Task,
} from "../../shared/schemas";
import { addDays, dateRange, diffDays, systemTimeZone, zonedNow } from "../../shared/time";
import type { Agent } from "../ai/agent";
import { summarizeItems } from "../ai/agent";
import { CALLBACK_PATH, ChatGptError, type ChatGptAuth } from "../ai/chatgpt/auth";
import { ChatGptProvider } from "../ai/providers/chatgpt";
import { SERVICE_NAMES, type KeyCheck } from "../ai/providers/services";
import type { AIProvider } from "../ai/providers/types";
import type { SavedApiKey, SecretStore } from "../secrets";
import { runSelfTest } from "../ai/selftest";
import { SYSTEM_PROMPT, buildPrompt } from "../ai/prompt";
import { toolDefinitions } from "../ai/tools";
import { VERSION } from "../version";
import type { AppConfig } from "../config";
import type { Database } from "../db/database";
import { seedDemo } from "../db/seed";
import { DbStore, OverlayStore, type Store, TrackingStore } from "../db/store";
import { classifyChanges, getHistory, listHistory, mutate, undoHistory } from "../domain/changes";
import { DomainError, localNow, newId, type DomainContext } from "../domain/context";
import {
  addMemory,
  createEvent,
  createProject,
  deleteEvent,
  deleteProject,
  eventsBetween,
  getDayPlan,
  patchDayPlan,
  removeMemory,
  updateEvent,
  updateProject,
} from "../domain/entities";
import { analyze, applyPlan, computePlan, dayView, dayWindow, findFreeTime, postponeTasks, suggestDay } from "../domain/planning";
import { applyProposal, createProposal, discardProposal, getProposal } from "../domain/proposals";
import {
  completeTask,
  createTask,
  deleteTask,
  editSubtasks,
  getTask,
  isOpen,
  isTemplate,
  materializeRecurring,
  moveTask,
  reopenTask,
  reorderTasks,
  scheduleTask,
  startTask,
  tasksForDate,
  unscheduleTask,
  updateTask,
} from "../domain/tasks";
import { log } from "../logger";
import { addFeed, fetchCalendar, findCalendarLink, hideCalendarLinks, listFeeds, removeFeed, syncFeed, type CalendarFetcher } from "../services/calendarFeeds";
import { addMessage, clearConversation, recentMessages } from "../services/conversation";
import { createBackup, deleteAllData, exportAll, hasDemoData, importAll, listBackups, restoreBackup } from "../services/data";
import { exportIcs, parseIcs } from "../services/ics";
import { listProposals } from "../domain/proposals";
import { loadSettings, patchSettings, setApiConsent } from "../services/settings";

interface Deps {
  db: Database;
  agent: Agent;
  config: AppConfig;
  clock: () => Date;
  providers: { claude_code: AIProvider; anthropic_api: AIProvider; chatgpt?: AIProvider };
  secrets: SecretStore;
  chatgptAuth: ChatGptAuth;
  onApiKeyChange: (saved: SavedApiKey | null) => void;
  verifyKey: (service: ApiService, key: string) => Promise<KeyCheck>;
  /** How calendar links are downloaded (tests pass their own). */
  fetchCalendar?: CalendarFetcher;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The page shown in the browser when a ChatGPT sign-in cannot finish. */
const signInFailedPage = (message: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>AURA</title></head>
<body style="font-family:system-ui,sans-serif;max-width:520px;margin:15vh auto;padding:0 16px;line-height:1.5">
<h1 style="font-size:20px">ChatGPT sign-in did not finish</h1><p>${escapeHtml(message)}</p>
<p><a href="/#/settings?section=assistant">Back to AURA</a></p></body></html>`;

/**
 * Keep only the keys the client actually sent (one level of nesting), so that
 * schema defaults never overwrite existing settings during a partial update.
 */
function onlyProvided(parsed: Record<string, unknown>, raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(raw as Record<string, unknown>)) {
    if (!(key in parsed)) continue;
    const value = parsed[key];
    const rawValue = (raw as Record<string, unknown>)[key];
    if (value && typeof value === "object" && !Array.isArray(value) && rawValue && typeof rawValue === "object") {
      out[key] = onlyProvided(value as Record<string, unknown>, rawValue);
    } else out[key] = value;
  }
  return out;
}

const zIdParam = z.object({ id: z.string().min(1).max(80) });
const zDateParam = z.object({ date: zDate });

export function registerRoutes(app: FastifyInstance, deps: Deps) {
  const { db, agent, config, clock } = deps;
  const fetcher = deps.fetchCalendar ?? fetchCalendar;
  const nowIso = () => clock().toISOString();
  const ctxFor = (store: Store): DomainContext => ({ store, settings: loadSettings(db), clock });
  const readCtx = () => ctxFor(new DbStore(db));

  /** Run a user mutation in a transaction, recorded for undo. */
  function act<T>(label: string | ((r: T) => string), fn: (ctx: DomainContext) => T) {
    const { result, history } = mutate(db, label, "user", (store: TrackingStore) => fn(ctxFor(store)), nowIso);
    return { result, historyId: history?.id ?? null };
  }

  function ensureRecurring() {
    db.tx(() => {
      const ctx = readCtx();
      const today = localNow(ctx).date;
      materializeRecurring(ctx, today, addDays(today, 14));
    });
  }

  // -------------------------------------------------------------------------
  // Meta
  // -------------------------------------------------------------------------

  app.get("/api/health", async () => ({ ok: true, version: VERSION, time: nowIso() }));

  app.get("/api/bootstrap", async (): Promise<Bootstrap> => {
    const ctx = readCtx();
    return {
      settings: ctx.settings,
      projects: ctx.store.all("project"),
      memory: ctx.store.all("memory"),
      version: VERSION,
      systemTimeZone: systemTimeZone(),
      hasDemoData: hasDemoData(db),
      dataDir: config.dataDir,
    };
  });

  app.get("/api/settings", async () => loadSettings(db));

  app.patch("/api/settings", async (req) => patchSettings(db, onlyProvided(zSettingsPatch.parse(req.body), req.body) as SettingsPatch));

  app.post("/api/settings/api-consent", async (req) => {
    const body = z.object({ granted: z.boolean(), acknowledgement: z.string().optional() }).parse(req.body);
    if (body.granted && body.acknowledgement !== "billed-separately") {
      throw new DomainError("validation", "Explicit acknowledgement that API usage is billed separately is required.");
    }
    if (body.granted && !deps.secrets.read().apiKey) {
      throw new DomainError("invalid_state", "No API key yet. Add yours in Settings > Assistant.");
    }
    const s = setApiConsent(db, body.granted);
    log.info("api billing consent changed", { granted: body.granted });
    return s;
  });

  // -------------------------------------------------------------------------
  // API key and ChatGPT sign-in (kept in the local secrets file, never in the database)
  // -------------------------------------------------------------------------

  app.post("/api/ai/key", async (req) => {
    const body = z.object({ key: z.string().min(1).max(500), service: z.enum(["anthropic", "deepseek"]).optional() }).parse(req.body);
    const key = body.key.trim();
    const detected = detectService(key);
    if (detected === "subscription_token") throw new DomainError("validation", "This is a Claude subscription token, not an API key. Create an API key in the Claude Console.");
    const service = body.service ?? (detected === "unknown" ? null : detected);
    if (!service) throw new DomainError("validation", "AURA does not recognize this key. Choose its service.");
    if (!looksLikeApiKey(key)) throw new DomainError("validation", "This does not look like an API key (it starts with sk-).");
    const check = await deps.verifyKey(service, key);
    if (check === "rejected") throw new DomainError("validation", `${SERVICE_NAMES[service]} refused this key.`);
    const previous = deps.secrets.read().apiKey?.service ?? null;
    deps.secrets.update((s) => ({ ...s, apiKey: { service, key } }));
    deps.onApiKeyChange({ service, key });
    if (previous !== service) {
      // The billing consent was given for one service: another one asks again.
      // Haiku is a Claude model, so with DeepSeek "Always Haiku" goes back to automatic.
      const current = loadSettings(db).ai;
      const patch: NonNullable<SettingsPatch["ai"]> = {};
      if (current.provider === "anthropic_api") patch.provider = "off";
      if (service === "deepseek" && current.modelMode === "haiku") patch.modelMode = "auto";
      if (Object.keys(patch).length) patchSettings(db, { ai: patch });
    }
    log.info("api key saved", { service, verified: check === "ok" });
    return { service, verified: check === "ok" };
  });

  app.delete("/api/ai/key", async () => {
    deps.secrets.update(({ apiKey: _removed, ...rest }) => rest);
    deps.onApiKeyChange(null);
    // Without a key the API cannot be used; leaving it also withdraws the billing consent.
    if (loadSettings(db).ai.provider === "anthropic_api") patchSettings(db, { ai: { provider: "off" } });
    return { removed: true };
  });

  /** Start a ChatGPT sign-in: the interface opens the returned OpenAI page. */
  app.post("/api/chatgpt/login", async () => ({ url: deps.chatgptAuth.startLogin(`http://127.0.0.1:${config.port}`) }));

  /** OpenAI sends the browser back here after the user signed in. */
  app.get(CALLBACK_PATH, async (req, reply) => {
    const query = Object.fromEntries(Object.entries((req.query ?? {}) as Record<string, unknown>).map(([k, v]) => [k, Array.isArray(v) ? String(v[0]) : typeof v === "string" ? v : undefined]));
    try {
      const { firstTime, account } = await deps.chatgptAuth.finishLogin(query);
      // Signing in from the assistant settings is how ChatGPT is chosen.
      if (account.planUsage) patchSettings(db, { ai: { provider: "chatgpt" } });
      log.info("chatgpt signed in", { firstTime, planUsage: account.planUsage });
      return reply.redirect(`/#/settings?section=assistant&chatgpt=${firstTime && account.planUsage ? "welcome" : "signed-in"}`);
    } catch (err) {
      log.warn("chatgpt sign-in failed", { code: err instanceof ChatGptError ? err.code : "unknown" });
      return reply.type("text/html").send(signInFailedPage(err instanceof ChatGptError ? err.message : "Something went wrong. Start again from AURA's settings."));
    }
  });

  app.post("/api/chatgpt/logout", async () => {
    const r = await deps.chatgptAuth.signOut();
    if (loadSettings(db).ai.provider === "chatgpt") patchSettings(db, { ai: { provider: "off" } });
    log.info("chatgpt signed out", r);
    return r;
  });

  app.get("/api/chatgpt/models", async () => {
    const provider = deps.providers.chatgpt;
    if (!(provider instanceof ChatGptProvider) || !deps.chatgptAuth.account()?.planUsage) return [];
    try {
      return await provider.listModels(true);
    } catch {
      return [];
    }
  });

  app.post("/api/onboarding", async (req) => {
    const body = z
      .object({
        displayName: z.string().max(60).default(""),
        language: z.enum(["en", "fr"]).default("en"),
        dayStart: zTime.optional(),
        dayEnd: zTime.optional(),
        keepDemo: z.boolean(),
      })
      .parse(req.body);
    const settings = patchSettings(db, {
      displayName: body.displayName,
      language: body.language,
      ...(body.dayStart ? { dayStart: body.dayStart } : {}),
      ...(body.dayEnd ? { dayEnd: body.dayEnd } : {}),
      onboarded: true,
    });
    if (!body.keepDemo) clearDemo();
    return settings;
  });

  // -------------------------------------------------------------------------
  // Days and ranges
  // -------------------------------------------------------------------------

  app.get("/api/day/:date", async (req) => {
    const { date } = zDateParam.parse(req.params);
    ensureRecurring();
    return dayView(readCtx(), date);
  });

  app.get("/api/range", async (req): Promise<RangeDay[]> => {
    const q = z.object({ from: zDate, to: zDate }).parse(req.query);
    if (q.to < q.from || diffDays(q.to, q.from) > 42) throw new DomainError("validation", "Ranges are limited to 6 weeks.");
    ensureRecurring();
    const ctx = readCtx();
    const events = eventsBetween(ctx, q.from, q.to);
    return dateRange(q.from, q.to).map((date) => {
      const plan = getDayPlan(ctx, date);
      const w = dayWindow(ctx.settings, plan, date);
      const { window: _w, ...analysis } = analyze(ctx, date);
      const hh = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      return {
        date,
        window: { start: hh(w.start), end: hh(w.end), isWorkDay: w.isWorkDay },
        events: events.filter((e) => e.occurrenceDate === date),
        tasks: tasksForDate(ctx, date),
        analysis,
        plan,
      };
    });
  });

  app.patch("/api/day/:date/plan", async (req) => {
    const { date } = zDateParam.parse(req.params);
    const body = zDayPlanPatch.parse(req.body);
    return act(`Changed the plan settings for ${date}`, (ctx) => patchDayPlan(ctx, date, body));
  });

  app.post("/api/day/:date/review", async (req) => {
    const { date } = zDateParam.parse(req.params);
    const body = z
      .object({
        note: z.string().max(4000).default(""),
        reasons: z.record(z.string(), z.string().max(500)).default({}),
        carryOver: z.array(z.object({ taskId: z.string(), toDate: zDate })).max(100).default([]),
      })
      .parse(req.body);
    return act(`Evening review for ${date}`, (ctx) => {
      for (const c of body.carryOver) postponeTasks(ctx, [c.taskId], c.toDate);
      return patchDayPlan(ctx, date, { review: { reviewedAt: nowIso(), note: body.note, reasons: body.reasons } });
    });
  });

  // -------------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------------

  app.get("/api/tasks", async (req) => {
    const q = z
      .object({
        scope: z.enum(["all", "open", "done", "inbox", "backlog", "templates"]).default("all"),
        q: z.string().max(200).optional(),
        project: z.string().optional(),
      })
      .parse(req.query);
    ensureRecurring();
    const text = q.q?.toLowerCase();
    return readCtx()
      .store.all("task")
      .filter((t) => (q.scope === "templates" ? isTemplate(t) : !isTemplate(t)))
      .filter((t) => {
        if (q.scope === "open") return isOpen(t) && t.status !== "inbox";
        if (q.scope === "done") return t.status === "done";
        if (q.scope === "inbox") return t.status === "inbox";
        if (q.scope === "backlog") return isOpen(t) && t.status !== "inbox" && !t.plannedDate;
        return true;
      })
      .filter((t) => (q.project ? t.projectId === q.project : true))
      .filter((t) => (text ? `${t.title} ${t.description} ${t.notes} ${t.tags.join(" ")}`.toLowerCase().includes(text) : true));
  });

  app.get("/api/tasks/:id", async (req) => getTask(readCtx(), zIdParam.parse(req.params).id));

  app.post("/api/tasks", async (req) => {
    const body = zTaskCreate.parse(req.body);
    return act((t: Task) => `Created “${t.title}”`, (ctx) => createTask(ctx, body));
  });

  app.patch("/api/tasks/:id", async (req) => {
    const { id } = zIdParam.parse(req.params);
    const body = zTaskPatch.parse(req.body);
    return act((t: Task) => `Edited “${t.title}”`, (ctx) => updateTask(ctx, id, body));
  });

  app.post("/api/tasks/:id/complete", async (req) => {
    const { id } = zIdParam.parse(req.params);
    const body = z.object({ actualMin: z.number().int().min(0).max(1440).nullable().optional() }).parse(req.body ?? {});
    return act((t: Task) => `Completed “${t.title}”`, (ctx) => {
      let actual = body.actualMin;
      if (actual === undefined) {
        const row = db.get<{ m: number | null }>("SELECT SUM(minutes) AS m FROM time_entries WHERE task_id = ?", id);
        actual = row?.m ? Number(row.m) : null;
      }
      return completeTask(ctx, id, { actualMin: actual });
    });
  });

  app.post("/api/tasks/:id/reopen", async (req) => {
    const { id } = zIdParam.parse(req.params);
    return act((t: Task) => `Reopened “${t.title}”`, (ctx) => reopenTask(ctx, id));
  });

  app.post("/api/tasks/:id/start", async (req) => {
    const { id } = zIdParam.parse(req.params);
    return act((t: Task) => `Started “${t.title}”`, (ctx) => startTask(ctx, id));
  });

  app.post("/api/tasks/:id/schedule", async (req) => {
    const { id } = zIdParam.parse(req.params);
    const body = z.object({ date: zDate, start: zTime, pin: z.boolean().default(true) }).parse(req.body);
    return act((t: Task) => `Scheduled “${t.title}”`, (ctx) => scheduleTask(ctx, id, body.date, body.start, { pin: body.pin }));
  });

  app.post("/api/tasks/:id/move", async (req) => {
    const { id } = zIdParam.parse(req.params);
    const body = z.object({ date: zDate, keepTime: z.boolean().default(false) }).parse(req.body);
    return act((t: Task) => `Moved “${t.title}”`, (ctx) => moveTask(ctx, id, body.date, { keepTime: body.keepTime }));
  });

  app.post("/api/tasks/:id/unschedule", async (req) => {
    const { id } = zIdParam.parse(req.params);
    const body = z.object({ toBacklog: z.boolean().default(false) }).parse(req.body ?? {});
    return act((t: Task) => `Unscheduled “${t.title}”`, (ctx) => unscheduleTask(ctx, id, body));
  });

  app.post("/api/tasks/:id/subtasks", async (req) => {
    const { id } = zIdParam.parse(req.params);
    const body = z
      .object({
        add: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
        toggle: z.array(z.string()).max(50).optional(),
        remove: z.array(z.string()).max(50).optional(),
        rename: z.array(z.object({ id: z.string(), title: z.string().trim().min(1).max(200) })).max(50).optional(),
      })
      .parse(req.body);
    return act((t: Task) => `Edited subtasks of “${t.title}”`, (ctx) => editSubtasks(ctx, id, body));
  });

  app.delete("/api/tasks/:id", async (req) => {
    const { id } = zIdParam.parse(req.params);
    const title = getTask(readCtx(), id).title;
    return act(`Deleted “${title}”`, (ctx) => {
      deleteTask(ctx, id);
      return { deleted: id };
    });
  });

  app.post("/api/tasks/reorder", async (req) => {
    const body = zReorder.parse(req.body);
    return act("Reordered tasks", (ctx) => reorderTasks(ctx, body.ids));
  });

  app.post("/api/tasks/postpone", async (req) => {
    const body = z.object({ ids: z.array(z.string()).min(1).max(200), toDate: zDate }).parse(req.body);
    return act(`Moved ${body.ids.length} task(s) to ${body.toDate}`, (ctx) => postponeTasks(ctx, body.ids, body.toDate));
  });

  app.post("/api/tasks/:id/time", async (req) => {
    const { id } = zIdParam.parse(req.params);
    const body = z
      .object({
        startedAt: z.string().datetime(),
        endedAt: z.string().datetime(),
        kind: z.enum(["focus", "pomodoro", "manual"]).default("focus"),
      })
      .parse(req.body);
    getTask(readCtx(), id);
    const minutes = Math.round((Date.parse(body.endedAt) - Date.parse(body.startedAt)) / 60000);
    if (minutes < 0 || minutes > 1440) throw new DomainError("validation", "Invalid time entry.");
    const entry = { id: newId("te"), taskId: id, ...body, minutes };
    db.run(
      "INSERT INTO time_entries (id, task_id, started_at, ended_at, minutes, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      entry.id,
      id,
      body.startedAt,
      body.endedAt,
      minutes,
      body.kind,
      nowIso(),
    );
    const total = Number(db.get<{ m: number }>("SELECT SUM(minutes) AS m FROM time_entries WHERE task_id = ?", id)?.m ?? 0);
    return { entry, totalMinutes: total };
  });

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------

  app.get("/api/projects", async () => {
    const ctx = readCtx();
    const tasks = ctx.store.all("task").filter((t) => !isTemplate(t));
    return ctx.store.all("project").map((p) => {
      const own = tasks.filter((t) => t.projectId === p.id && t.status !== "cancelled");
      const done = own.filter((t) => t.status === "done");
      return {
        ...p,
        stats: {
          total: own.length,
          done: done.length,
          openMin: own.filter(isOpen).reduce((s, t) => s + t.estimateMin, 0),
          pct: own.length ? Math.round((done.length / own.length) * 100) : 0,
        },
      };
    });
  });

  app.post("/api/projects", async (req) => {
    const body = zProjectCreate.parse(req.body);
    return act((p: { name: string }) => `Created project “${p.name}”`, (ctx) => createProject(ctx, body));
  });

  app.patch("/api/projects/:id", async (req) => {
    const { id } = zIdParam.parse(req.params);
    const body = zProjectPatch.parse(req.body);
    return act((p: { name: string }) => `Edited project “${p.name}”`, (ctx) => updateProject(ctx, id, body));
  });

  app.delete("/api/projects/:id", async (req) => {
    const { id } = zIdParam.parse(req.params);
    const q = z.object({ deleteTasks: z.enum(["true", "false"]).default("false") }).parse(req.query);
    const name = readCtx().store.get("project", id)?.name ?? id;
    return act(`Deleted project “${name}”`, (ctx) => {
      deleteProject(ctx, id, { deleteTasks: q.deleteTasks === "true" });
      return { deleted: id };
    });
  });

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  app.get("/api/events", async (req) => {
    const q = z.object({ from: zDate, to: zDate }).parse(req.query);
    return eventsBetween(readCtx(), q.from, q.to);
  });

  app.post("/api/events", async (req) => {
    const body = zEventCreate.parse(req.body);
    return act((e: { title: string }) => `Added “${e.title}”`, (ctx) => createEvent(ctx, body));
  });

  app.patch("/api/events/:id", async (req) => {
    const { id } = zIdParam.parse(req.params);
    const body = zEventPatch.parse(req.body);
    return act((e: { title: string }) => `Edited “${e.title}”`, (ctx) => updateEvent(ctx, id, body));
  });

  app.delete("/api/events/:id", async (req) => {
    const { id } = zIdParam.parse(req.params);
    const q = z.object({ occurrence: zDate.optional() }).parse(req.query);
    const title = readCtx().store.get("event", id)?.title ?? id;
    return act(`Deleted “${title}”`, (ctx) => {
      deleteEvent(ctx, id, q.occurrence ? { occurrenceDate: q.occurrence } : {});
      return { deleted: id };
    });
  });

  // -------------------------------------------------------------------------
  // Scheduling engine (works without any AI)
  // -------------------------------------------------------------------------

  app.post("/api/schedule/plan", async (req) => {
    const body = zPlanRequest.parse(req.body);
    ensureRecurring();
    const overlay = new OverlayStore(new DbStore(db));
    const ctx = ctxFor(overlay);
    const result = computePlan(ctx, body.date, {
      mode: body.mode,
      ...(body.intensity ? { intensity: body.intensity } : {}),
      ...(body.blockFromNowMin ? { blockFromNowMin: body.blockFromNowMin } : {}),
    });
    applyPlan(ctx, result, { accept: true, ...(body.intensity ? { intensity: body.intensity } : {}) });
    const tomorrow = addDays(body.date, 1);
    for (const o of result.overflow) {
      const t = ctx.store.get("task", o.taskId);
      (o as { suggestedDate?: string | null }).suggestedDate = t ? suggestDay(ctx, t, tomorrow) : null;
    }
    const changes = overlay.getChanges();
    const proposal = createProposal(db, {
      messageId: null,
      source: "engine",
      summary: "",
      reason: classifyChanges(changes).reason,
      requiresApproval: true,
      changes,
      preview: { plans: [result] },
      createdAt: nowIso(),
    });
    db.run("UPDATE proposals SET summary = ? WHERE id = ?", changes.length ? summarizeItems(proposal.items) : "No changes needed", proposal.id);
    return getProposal(db, proposal.id);
  });

  app.get("/api/schedule/free", async (req) => {
    const q = z.object({ from: zDate, to: zDate, min: z.coerce.number().int().min(5).max(600).default(30) }).parse(req.query);
    if (diffDays(q.to, q.from) > 31) throw new DomainError("validation", "Search at most 31 days.");
    return findFreeTime(readCtx(), q.from, q.to, q.min);
  });

  // -------------------------------------------------------------------------
  // Proposals and history (undo)
  // -------------------------------------------------------------------------

  app.get("/api/proposals/:id", async (req) => {
    const p = getProposal(db, zIdParam.parse(req.params).id);
    if (!p) throw new DomainError("not_found", "This proposal no longer exists.");
    return p;
  });

  app.post("/api/proposals/:id/apply", async (req) => {
    const { id } = zIdParam.parse(req.params);
    const body = z.object({ exclude: z.array(z.string()).max(500).default([]) }).parse(req.body ?? {});
    return applyProposal(db, id, { exclude: body.exclude, nowIso: nowIso() });
  });

  app.post("/api/proposals/:id/discard", async (req) => discardProposal(db, zIdParam.parse(req.params).id, nowIso()));

  app.get("/api/history", async () => listHistory(db, 60).map(({ changes, ...h }) => ({ ...h, count: changes.length })));

  app.post("/api/history/:id/undo", async (req) => {
    const entry = undoHistory(db, zIdParam.parse(req.params).id, nowIso());
    return { undone: entry.id, label: entry.label };
  });

  app.post("/api/history/undo-last", async () => {
    const last = listHistory(db, 20).find((h) => !h.undoneAt);
    if (!last) throw new DomainError("not_found", "Nothing to undo.");
    const entry = undoHistory(db, last.id, nowIso());
    return { undone: entry.id, label: entry.label };
  });

  app.get("/api/history/:id", async (req) => {
    const h = getHistory(db, zIdParam.parse(req.params).id);
    if (!h) throw new DomainError("not_found", "Not found.");
    return h;
  });

  // -------------------------------------------------------------------------
  // Assistant
  // -------------------------------------------------------------------------

  app.get("/api/ai/status", async (req) => {
    const q = z.object({ force: z.enum(["0", "1"]).optional() }).parse(req.query);
    return agent.status(q.force === "1");
  });

  app.get("/api/ai/conversation", async () => {
    const messages = recentMessages(db, 200).filter((m) => m.meta.kind !== "brief");
    const ids = messages.map((m) => m.meta.proposalId).filter((x): x is string => Boolean(x));
    return { messages, proposals: listProposals(db, ids), busy: agent.busy };
  });

  app.delete("/api/ai/conversation", async () => {
    clearConversation(db);
    return { cleared: true };
  });

  app.post("/api/ai/chat", async (req, reply) => {
    const body = z
      .object({
        message: z.string().max(8000).default(""),
        model: z.enum(["auto", "sonnet", "opus", "haiku"]).optional(),
        effort: z.union([zEffort, z.literal("auto")]).optional(),
        retryOf: z.string().optional(),
      })
      .parse(req.body);
    if (agent.busy) throw new DomainError("conflict", "AURA is still working on your previous request.");
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    });
    const send = (e: ChatStreamEvent) => {
      if (!reply.raw.writableEnded) reply.raw.write(JSON.stringify(e) + "\n");
    };
    // A calendar link is added here, without the AI: the link holds a private key and is never sent to it.
    const calendarLink = body.retryOf ? null : findCalendarLink(body.message);
    try {
      if (calendarLink) {
        await addCalendarFromChat(body.message, calendarLink, send);
      } else {
        await agent.chat(
          {
            message: body.message,
            ...(body.model ? { model: body.model } : {}),
            ...(body.effort ? { effort: body.effort } : {}),
            ...(body.retryOf ? { retryOf: body.retryOf } : {}),
          },
          send,
        );
      }
    } catch (err) {
      const message = err instanceof DomainError ? err.message : "Something went wrong. Your data was not changed.";
      reply.raw.write(JSON.stringify({ type: "fatal", message }) + "\n");
    } finally {
      reply.raw.end();
    }
  });

  async function addCalendarFromChat(message: string, link: string, send: (e: ChatStreamEvent) => void) {
    const fr = loadSettings(db).language === "fr";
    const userMessage = addMessage(db, "user", hideCalendarLinks(message, fr ? "[lien du calendrier]" : "[calendar link]"));
    send({ type: "accepted", userMessage, routing: null });
    try {
      const r = await addFeed(db, link, fetcher, clock);
      const { name, eventCount } = r.feed;
      const text = r.created
        ? fr
          ? `Calendrier « ${name} » ajouté : ${eventCount} événements, dont ${r.upcoming} à venir. AURA le télécharge de nouveau toutes les 6 heures, sans passer par l'IA. Il se gère dans Réglages > Données > Calendriers par lien.`
          : `Calendar "${name}" added: ${eventCount} events, ${r.upcoming} of them upcoming. AURA downloads it again every 6 hours, without the AI. Manage it in Settings > Data > Calendars by link.`
        : fr
          ? `Le calendrier « ${name} » était déjà là : il est à jour (${r.added} ajoutés, ${r.updated} modifiés, ${r.removed} retirés).`
          : `Calendar "${name}" was already added and is now up to date (${r.added} added, ${r.updated} changed, ${r.removed} removed).`;
      send({ type: "done", message: addMessage(db, "assistant", text, { status: "ok", kind: "chat", local: true }), proposal: null });
    } catch (err) {
      const text = err instanceof DomainError ? err.message : "The calendar could not be added.";
      send({ type: "error", message: addMessage(db, "assistant", text, { status: "error", kind: "chat", local: true, error: { code: "calendar", message: text } }) });
    }
  }

  app.post("/api/ai/cancel", async () => ({ cancelled: agent.cancel() }));

  /** Exactly what would be sent to Claude with the next message (for transparency). */
  app.get("/api/ai/context-preview", async () => {
    ensureRecurring();
    const settings = loadSettings(db);
    const ctx = readCtx();
    const history = recentMessages(db, 200).filter((m) => m.meta.kind !== "brief");
    const ids = history.map((m) => m.meta.proposalId).filter((x): x is string => Boolean(x));
    const proposals = new Map(listProposals(db, ids).map((p) => [p.id, p]));
    const prompt = buildPrompt(ctx, "<your next message>", history, proposals, settings.ai.historyTurns);
    return {
      system: SYSTEM_PROMPT,
      prompt,
      characters: SYSTEM_PROMPT.length + prompt.length,
      tools: toolDefinitions().map((d) => d.name),
      historyTurns: settings.ai.historyTurns,
    };
  });

  app.post("/api/ai/brief", async (req) => {
    const body = z.object({ date: zDate }).parse(req.body);
    return agent.brief(body.date);
  });

  app.post("/api/ai/self-test", async () => runSelfTest(db, loadSettings(db), clock));

  // -------------------------------------------------------------------------
  // Memory
  // -------------------------------------------------------------------------

  app.get("/api/memory", async () => readCtx().store.all("memory"));

  app.post("/api/memory", async (req) => {
    const body = z.object({ text: z.string().min(3).max(400) }).parse(req.body);
    return act("Saved a note for the assistant", (ctx) => addMemory(ctx, body.text, "user"));
  });

  app.delete("/api/memory/:id", async (req) => {
    const { id } = zIdParam.parse(req.params);
    return act("Deleted an assistant note", (ctx) => {
      removeMemory(ctx, id);
      return { deleted: id };
    });
  });

  // -------------------------------------------------------------------------
  // Calendar files
  // -------------------------------------------------------------------------

  app.get("/api/calendar/export.ics", async (req, reply) => {
    const ctx = readCtx();
    const today = localNow(ctx).date;
    const q = z.object({ from: zDate.default(addDays(today, -30)), to: zDate.default(addDays(today, 90)) }).parse(req.query);
    const events = ctx.store.all("event").filter((e) => e.recurrence !== null || (e.date >= q.from && e.date <= q.to));
    const tasks = ctx.store.all("task").filter((t) => !isTemplate(t) && t.scheduledStart && t.plannedDate && t.plannedDate >= q.from && t.plannedDate <= q.to);
    reply.header("content-type", "text/calendar; charset=utf-8").header("content-disposition", 'attachment; filename="aura-calendar.ics"');
    return exportIcs(events, tasks, ctx.settings.timeZone);
  });

  app.post("/api/calendar/import", async (req) => {
    const body = z.object({ ics: z.string().min(10).max(5_000_000) }).parse(req.body);
    const tz = loadSettings(db).timeZone;
    const parsed = parseIcs(body.ics, tz);
    if (parsed.events.length === 0) throw new DomainError("validation", "No events were found in this file.");
    const { result, historyId } = act(`Imported ${parsed.events.length} calendar event(s)`, (ctx) => {
      const existing = new Set(ctx.store.all("event").map((e) => `${e.date}|${e.start}|${e.title}`));
      let imported = 0;
      let duplicates = 0;
      for (const e of parsed.events) {
        const key = `${e.date}|${e.start}|${e.title}`;
        if (existing.has(key)) {
          duplicates++;
          continue;
        }
        createEvent(ctx, {
          title: e.title,
          date: e.date,
          start: e.start,
          end: e.end,
          allDay: e.allDay,
          kind: "commitment",
          location: e.location,
          notes: e.notes,
          recurrence: e.recurrence,
          source: "ics",
        });
        existing.add(key);
        imported++;
      }
      return { imported, duplicates, skipped: parsed.skipped };
    });
    return { ...result, historyId };
  });

  // -------------------------------------------------------------------------
  // Calendars added by link (downloaded again every few hours)
  // -------------------------------------------------------------------------

  app.get("/api/calendars", async () => listFeeds(db));

  app.post("/api/calendars", async (req) => {
    const body = z.object({ url: z.string().min(8).max(2000) }).parse(req.body);
    return addFeed(db, body.url, fetcher, clock);
  });

  app.post("/api/calendars/:id/refresh", async (req) => syncFeed(db, zIdParam.parse(req.params).id, fetcher, clock));

  app.delete("/api/calendars/:id", async (req) => removeFeed(db, zIdParam.parse(req.params).id));

  // -------------------------------------------------------------------------
  // Data: export, import, backups, deletion
  // -------------------------------------------------------------------------

  app.get("/api/data/export", async (req, reply) => {
    const stamp = zonedNow(loadSettings(db).timeZone).date;
    reply.header("content-disposition", `attachment; filename="aura-export-${stamp}.json"`);
    return exportAll(db);
  });

  app.post("/api/data/import", async (req) => {
    if (!zExportFile.safeParse(req.body).success) return importAll(db, req.body); // throws a validation error
    createBackup(db, config.dataDir, "before-import");
    return importAll(db, req.body);
  });

  app.get("/api/data/backups", async () => listBackups(config.dataDir));

  app.post("/api/data/backups", async () => createBackup(db, config.dataDir, "manual"));

  app.post("/api/data/backups/:name/restore", async (req) => {
    const { name } = z.object({ name: z.string().max(120) }).parse(req.params);
    const safety = restoreBackup(db, config.dataDir, name);
    return { restored: name, safetyBackup: safety.name };
  });

  function clearDemo() {
    return act("Removed the example data", (ctx) => {
      const store = ctx.store;
      for (const t of store.all("task")) if (t.isDemo && store.get("task", t.id)) store.remove("task", t.id);
      for (const e of store.all("event")) if (e.isDemo) store.remove("event", e.id);
      for (const p of store.all("project")) if (p.isDemo) store.remove("project", p.id);
      const remainingDays = new Set(store.all("task").map((t) => t.plannedDate));
      for (const d of store.all("dayPlan")) if (!remainingDays.has(d.date)) store.remove("dayPlan", d.date);
      return { cleared: true };
    });
  }

  app.post("/api/data/clear-demo", async () => clearDemo());

  app.post("/api/data/load-demo", async () => {
    if (hasDemoData(db)) throw new DomainError("invalid_state", "The example data is already loaded.");
    return act("Loaded the example data", (ctx) => {
      seedDemo(ctx.store, ctx.settings, clock());
      return { loaded: true };
    });
  });

  app.post("/api/data/delete-all", async (req) => {
    const body = z.object({ confirm: z.literal("DELETE"), backup: z.boolean().default(true) }).parse(req.body);
    const backup = body.backup ? createBackup(db, config.dataDir, "before-delete") : null;
    deleteAllData(db);
    log.info("all data deleted", { backup: Boolean(backup) });
    return { deleted: true, backup: backup?.name ?? null };
  });

  // -------------------------------------------------------------------------
  // Statistics
  // -------------------------------------------------------------------------

  app.get("/api/stats", async (req): Promise<StatsSummary> => {
    const q = z.object({ days: z.coerce.number().int().min(7).max(60).default(14) }).parse(req.query);
    const ctx = readCtx();
    const tz = ctx.settings.timeZone;
    const today = localNow(ctx).date;
    const from = addDays(today, -(q.days - 1));
    const dayOf = (iso: string) => zonedNow(tz, new Date(iso)).date;
    const done = ctx.store.all("task").filter((t) => t.status === "done" && t.completedAt);
    const entries = db.all<{ started_at: string; minutes: number }>("SELECT started_at, minutes FROM time_entries WHERE started_at >= ?", `${from}T00:00:00Z`);
    const days = dateRange(from, today).map((date) => {
      const completed = done.filter((t) => dayOf(t.completedAt!) === date);
      return {
        date,
        completed: completed.length,
        plannedMin: completed.reduce((s, t) => s + t.estimateMin, 0),
        actualMin: completed.reduce((s, t) => s + (t.actualMin ?? 0), 0),
        focusMin: entries.filter((e) => dayOf(e.started_at) === date).reduce((s, e) => s + Number(e.minutes), 0),
      };
    });
    const week = days.slice(-7);
    const withActual = done.filter((t) => t.actualMin && t.actualMin > 0);
    const accuracy = withActual.length
      ? withActual.reduce((s, t) => s + Math.min(t.estimateMin, t.actualMin!) / Math.max(t.estimateMin, t.actualMin!), 0) / withActual.length
      : null;
    const dv = dayView(ctx, today);
    return {
      days,
      completedThisWeek: week.reduce((s, d) => s + d.completed, 0),
      focusMinutesThisWeek: week.reduce((s, d) => s + d.focusMin, 0),
      estimateAccuracy: accuracy === null ? null : Math.round(accuracy * 100),
      streak: dv.streak,
    };
  });
}
