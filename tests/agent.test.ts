import { describe, expect, it, vi } from "vitest";
import type { AiStatus, ChatStreamEvent } from "../shared/api";
import type { Settings } from "../shared/schemas";
import { Agent } from "../server/ai/agent";
import { routeRequest } from "../server/ai/router";
import { runSelfTest } from "../server/ai/selftest";
import { executeTool, toolDefinitions, type RunContext } from "../server/ai/tools";
import { ProviderError, type AIProvider, type ProviderRunRequest, type ProviderRunResult } from "../server/ai/providers/types";
import { DbStore, OverlayStore } from "../server/db/store";
import { applyProposal, getProposal } from "../server/domain/proposals";
import { undoHistory } from "../server/domain/changes";
import { createEvent } from "../server/domain/entities";
import { createTask } from "../server/domain/tasks";
import { recentMessages } from "../server/services/conversation";
import { patchSettings } from "../server/services/settings";
import { clockAt, dbCtx, memoryDb, testSettings } from "./helpers";

const clock = clockAt("2026-10-25T20:00");

type Script = (req: ProviderRunRequest) => string | Promise<string>;

/** Test double that drives the real tool executor, exactly like the MCP bridge does. */
class ScriptedProvider implements AIProvider {
  readonly billing: "subscription" | "api";
  calls = 0;
  constructor(
    readonly id: "claude_code" | "anthropic_api",
    private script: Script,
  ) {
    this.billing = id === "claude_code" ? "subscription" : "api";
  }
  async status(): Promise<AiStatus> {
    return {
      provider: this.id,
      state: "ready",
      billing: this.billing,
      message: "ready",
      detail: {},
      models: [],
      efforts: ["low", "medium", "high", "xhigh"],
      effortSupported: true,
      lastModel: null,
      rateLimit: null,
      apiKeyConfigured: false,
      apiConsent: false,
      apiService: null,
      chatgpt: null,
      checkedAt: new Date().toISOString(),
    };
  }
  async run(req: ProviderRunRequest, _settings: Settings): Promise<ProviderRunResult> {
    this.calls++;
    const text = await this.script(req);
    return { text, model: "claude-sonnet-test", effortApplied: true, usage: null };
  }
}

function setup(script: Script, apiScript: Script = () => "api") {
  const db = memoryDb();
  const claude = new ScriptedProvider("claude_code", script);
  const api = new ScriptedProvider("anthropic_api", apiScript);
  const agent = new Agent({ db, providers: { claude_code: claude, anthropic_api: api }, clock });
  return { db, agent, claude, api };
}

async function chat(agent: Agent, message: string) {
  const events: ChatStreamEvent[] = [];
  await agent.chat({ message }, (e) => events.push(e));
  return events;
}

function call(req: ProviderRunRequest, name: string, input: unknown) {
  return executeTool(req.run, name, input);
}

describe("tool execution safety", () => {
  function run(): { rc: RunContext; db: ReturnType<typeof memoryDb> } {
    const db = memoryDb();
    createTask(dbCtx(db, clock), { title: "Existing", plannedDate: "2026-10-26" });
    const overlay = new OverlayStore(new DbStore(db));
    return {
      db,
      rc: { id: "r", token: "t", overlay, ctx: { store: overlay, settings: testSettings(), clock }, readOnly: false, toolCalls: [], plans: [], maxToolCalls: 40, closed: false },
    };
  }

  it("rejects malformed model output and leaves staged data untouched", () => {
    const { rc, db } = run();
    const bad: [string, unknown][] = [
      ["create_task", {}],
      ["create_task", { title: 12 }],
      ["create_task", { title: "x", estimateMin: 99999 }],
      ["schedule_task", { id: "t_x", date: "tomorrow", start: "6pm" }],
      ["update_task", { id: "t_x", priority: "urgent" }],
      ["plan_day", "not an object"],
      ["move_task", ["array"]],
      ["no_such_tool", {}],
    ];
    for (const [name, input] of bad) {
      const r = executeTool(rc, name, input);
      expect(r.ok, `${name} should be rejected`).toBe(false);
    }
    expect(rc.overlay.getChanges()).toEqual([]);
    expect(new DbStore(db).all("task")).toHaveLength(1);
  });

  it("rolls back a tool call that fails half-way", () => {
    const { rc } = run();
    const r = executeTool(rc, "postpone_tasks", { ids: [rc.overlay.all("task")[0]!.id, "t_missing"], toDate: "2026-10-27" });
    expect(r.ok).toBe(false);
    expect(rc.overlay.getChanges()).toEqual([]);
  });

  it("stages writes in the overlay instead of the database", () => {
    const { rc, db } = run();
    const r = executeTool(rc, "create_task", { title: "Staged", plannedDate: "2026-10-26", estimateMin: 30 });
    expect(r.ok).toBe(true);
    expect(rc.overlay.getChanges()).toHaveLength(1);
    expect(new DbStore(db).all("task")).toHaveLength(1);
  });

  it("refuses writes in a read-only run and after the run is closed", () => {
    const { rc } = run();
    rc.readOnly = true;
    expect(executeTool(rc, "create_task", { title: "x" }).ok).toBe(false);
    rc.readOnly = false;
    rc.closed = true;
    expect(executeTool(rc, "get_day", {}).ok).toBe(false);
  });

  it("publishes JSON schemas for every tool", () => {
    const defs = toolDefinitions();
    expect(defs.length).toBeGreaterThan(25);
    for (const d of defs) expect(d.inputSchema.type).toBe("object");
    expect(toolDefinitions(true).every((d) => !["create_task", "delete_task", "plan_day"].includes(d.name))).toBe(true);
  });

  it("self-test passes on a real database", () => {
    const db = memoryDb();
    createTask(dbCtx(db, clock), { title: "Existing" });
    const r = runSelfTest(db, testSettings(), clock);
    expect(r.passed).toBe(true);
    expect(r.results.every((x) => x.rejected)).toBe(true);
  });
});

describe("agent orchestration", () => {
  it("auto-applies a minor change and records it for undo", async () => {
    const { db, agent } = setup((req) => {
      const r = call(req, "create_task", { title: "Stretch", plannedDate: "2026-10-26", estimateMin: 20 });
      expect(r.ok).toBe(true);
      return "I've added a stretching task for tomorrow.";
    });
    const events = await chat(agent, "Add a stretching task tomorrow");
    const done = events.find((e) => e.type === "done") as Extract<ChatStreamEvent, { type: "done" }>;
    expect(done.proposal?.status).toBe("auto_applied");
    expect(new DbStore(db).all("task").map((t) => t.title)).toContain("Stretch");
    undoHistory(db, done.proposal!.historyId!, new Date().toISOString());
    expect(new DbStore(db).all("task").map((t) => t.title)).not.toContain("Stretch");
  });

  it("holds a significant change for approval and only writes after approval", async () => {
    const { db, agent } = setup((req) => {
      call(req, "create_event", { title: "Class", date: "2026-10-26", start: "09:00", end: "12:00" });
      for (const [title, estimateMin] of [["Study", 120], ["Project", 90], ["Exercise", 60], ["Groceries", 30]] as const) {
        call(req, "create_task", { title, estimateMin, plannedDate: "2026-10-26" });
      }
      const plan = call(req, "plan_day", { date: "2026-10-26", mode: "full" });
      expect(plan.ok).toBe(true);
      return "Here's a plan for tomorrow.";
    });
    const events = await chat(agent, "Tomorrow I have class 9-12; plan study, project, exercise, groceries");
    const done = events.find((e) => e.type === "done") as Extract<ChatStreamEvent, { type: "done" }>;
    expect(done.proposal?.status).toBe("pending");
    expect(done.proposal?.requiresApproval).toBe(true);
    expect(done.proposal?.preview?.plans[0]?.placements).toHaveLength(4);
    expect(new DbStore(db).all("task")).toHaveLength(0);

    const applied = applyProposal(db, done.proposal!.id, { nowIso: new Date().toISOString() });
    expect(applied.status).toBe("applied");
    const tasks = new DbStore(db).all("task");
    expect(tasks).toHaveLength(4);
    expect(tasks.every((t) => t.scheduledStart !== null)).toBe(true);
    expect(new DbStore(db).all("event")).toHaveLength(1);
  });

  it("refuses to apply a proposal when the data changed in the meantime", async () => {
    const { db, agent } = setup(() => "unused");
    const ctx = dbCtx(db, clock);
    const t = createTask(ctx, { title: "Original", plannedDate: "2026-10-26" });
    const agent2 = new Agent({
      db,
      providers: {
        claude_code: new ScriptedProvider("claude_code", (req) => {
          for (const title of ["a", "b", "c", "d"]) call(req, "create_task", { title });
          call(req, "update_task", { id: t.id, title: "Renamed by AI" });
          return "ok";
        }),
        anthropic_api: new ScriptedProvider("anthropic_api", () => ""),
      },
      clock,
    });
    void agent;
    const events = await chat(agent2, "rename and add things");
    const done = events.find((e) => e.type === "done") as Extract<ChatStreamEvent, { type: "done" }>;
    // The user edits the task before approving.
    const { updateTask } = await import("../server/domain/tasks");
    updateTask(dbCtx(db, clock), t.id, { title: "Edited by user" });
    expect(() => applyProposal(db, done.proposal!.id, { nowIso: new Date().toISOString() })).toThrow(/changed since/);
    expect(new DbStore(db).get("task", t.id)!.title).toBe("Edited by user");
    expect(getProposal(db, done.proposal!.id)!.status).toBe("failed");
  });

  it("requires approval for deletions", async () => {
    const { db, agent } = setup((req) => {
      const id = req.run.overlay.all("task")[0]!.id;
      call(req, "delete_task", { id });
      return "Prepared.";
    });
    createTask(dbCtx(db, clock), { title: "Precious" });
    const events = await chat(agent, "delete the precious task");
    const done = events.find((e) => e.type === "done") as Extract<ChatStreamEvent, { type: "done" }>;
    expect(done.proposal?.requiresApproval).toBe(true);
    expect(new DbStore(db).all("task")).toHaveLength(1);
  });

  it("keeps data intact and reports clearly when the model fails mid-run", async () => {
    const { db, agent, api } = setup((req) => {
      call(req, "create_task", { title: "Half-done" });
      call(req, "create_task", { title: 5 });
      throw new ProviderError("rate_limit", "Usage limit reached.", "switch_to_api");
    });
    createEvent(dbCtx(db, clock), { title: "Keep", date: "2026-10-26", start: "09:00", end: "10:00" });
    const events = await chat(agent, "plan everything");
    const err = events.find((e) => e.type === "error") as Extract<ChatStreamEvent, { type: "error" }>;
    expect(err.message.meta.error).toMatchObject({ code: "rate_limit", suggestion: "switch_to_api" });
    expect(new DbStore(db).all("task")).toHaveLength(0);
    expect(new DbStore(db).all("event")).toHaveLength(1);
    // Never falls back to separately billed API usage on its own.
    expect(api.calls).toBe(0);
  });

  it("does not fabricate a response when the assistant is turned off", async () => {
    const { db, agent, claude } = setup(() => "should not run");
    patchSettings(db, { ai: { provider: "off" } });
    await expect(chat(agent, "hello")).rejects.toThrow(/turned off/);
    expect(claude.calls).toBe(0);
    expect(recentMessages(db)).toHaveLength(0);
    const status = await agent.status();
    expect(status.state).toBe("disabled");
  });

  it("rejects a second request while one is running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { agent } = setup(async () => {
      await gate;
      return "done";
    });
    const first = chat(agent, "first");
    await vi.waitFor(() => expect(agent.busy).toBe(true));
    await expect(chat(agent, "second")).rejects.toThrow(/still working/);
    release();
    await first;
  });

  it("keeps the conversation and gives the model the history", async () => {
    const prompts: string[] = [];
    const { db, agent } = setup((req) => {
      prompts.push(req.prompt);
      return "noted";
    });
    await chat(agent, "My exam is on Friday");
    await chat(agent, "Move it to Saturday");
    expect(prompts[1]).toContain("My exam is on Friday");
    expect(recentMessages(db).map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });
});

describe("model routing", () => {
  const s = testSettings();
  it("uses Sonnet with low effort for simple actions", () => {
    expect(routeRequest("Add a task to call mom", s)).toMatchObject({ level: "simple", model: "sonnet", effort: "low" });
  });
  it("uses more reasoning for planning requests", () => {
    const r = routeRequest(
      "Tomorrow I have class from 09:00 to 12:00. I need to study for two hours, work on a project for 90 minutes, exercise for one hour, and buy groceries for 30 minutes. I want a lunch break and to finish by 20:00.",
      s,
    );
    expect(r.model).toBe("sonnet");
    expect(["moderate", "complex"]).toContain(r.level);
    expect(r.effort).not.toBe("low");
  });
  it("escalates very complex, disrupted multi-day requests to Opus when enabled", () => {
    const r = routeRequest(
      "Everything went wrong this week: I lost two days being sick, so reorganize my whole week. I have the SC-200 exam Friday, a lab report due Thursday, three internship applications, gym, groceries, and a group project meeting I can't move. Not sure what to drop; maybe the reading?",
      s,
    );
    expect(r).toMatchObject({ level: "complex", model: "opus", escalated: true });
    const off = routeRequest("Everything went wrong this week: reorganize my whole week, all unfinished tasks, exam friday, report thursday, sick, behind", testSettings({ ai: { ...s.ai, opusEscalation: false } }));
    expect(off.model).toBe("sonnet");
  });
  it("treats rescheduling and reprioritizing as moderate", () => {
    expect(routeRequest("Move exercise to 18:00 and make the project my highest priority.", s)).toMatchObject({ level: "moderate", model: "sonnet", effort: "medium" });
  });
  it("honours a manual override", () => {
    expect(routeRequest("Add a task", s, { model: "opus", effort: "high" })).toMatchObject({ model: "opus", effort: "high", auto: false });
  });
});
