// Agent orchestration: routing, prompt construction, provider call, and the
// conversion of staged tool changes into a reviewable proposal.
//
// Model execution is fully separated from business logic: providers only talk
// to the model, tools only call domain functions, and nothing reaches SQLite
// until a proposal is applied (automatically for minor changes, otherwise
// after the user's explicit approval).

import { randomBytes } from "node:crypto";
import type { AiStatus, ApiService, ChangeSummary, ChatGptAccount, ChatMessage, ChatStreamEvent, MessageMeta, Proposal, RoutingDecision } from "../../shared/api";
import type { Effort, Settings } from "../../shared/schemas";
import { addDays } from "../../shared/time";
import type { Database } from "../db/database";
import { DbStore, OverlayStore } from "../db/store";
import { classifyChanges } from "../domain/changes";
import { DomainError, localNow, newId, type DomainContext } from "../domain/context";
import { patchDayPlan } from "../domain/entities";
import { applyProposal, createProposal, getProposal, linkProposalMessage, listProposals } from "../domain/proposals";
import { materializeRecurring } from "../domain/tasks";
import { log } from "../logger";
import { addMessage, getMessage, recentMessages } from "../services/conversation";
import { loadSettings } from "../services/settings";
import { BRIEF_PROMPT, SYSTEM_PROMPT, buildPrompt } from "./prompt";
import { ProviderError, type AIProvider } from "./providers/types";
import { routeRequest, type RouteOverride } from "./router";
import type { RunContext } from "./tools";

export interface AgentDeps {
  db: Database;
  providers: { claude_code: AIProvider; anthropic_api: AIProvider; chatgpt?: AIProvider };
  clock: () => Date;
  /** The saved API key's service and the ChatGPT account, shown whichever provider is in use. */
  accounts?: () => { apiService: ApiService | null; chatgpt: ChatGptAccount | null };
}

export interface ChatInput {
  message: string;
  model?: RouteOverride["model"];
  effort?: Effort | "auto";
  retryOf?: string;
}

const MAX_TOOL_CALLS = 40;

export function summarizeItems(items: ChangeSummary[]): string {
  const count = (pred: (i: ChangeSummary) => boolean) => items.filter(pred).length;
  const parts: string[] = [];
  const createdTasks = count((i) => i.entity === "task" && i.kind === "created");
  const createdEvents = count((i) => i.entity === "event" && i.kind === "created");
  const scheduled = count((i) => i.entity === "task" && (i.kind === "scheduled" || i.kind === "moved"));
  const completed = count((i) => i.kind === "completed");
  const deleted = count((i) => i.kind === "deleted");
  const updated = count((i) => i.entity !== "dayPlan" && i.entity !== "memory" && (i.kind === "updated" || i.kind === "unscheduled" || i.kind === "reopened"));
  const projects = count((i) => i.entity === "project" && i.kind === "created");
  const memory = count((i) => i.entity === "memory");
  const dayPlan = count((i) => i.entity === "dayPlan");
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (createdTasks) parts.push(`add ${plural(createdTasks, "task", "tasks")}`);
  if (createdEvents) parts.push(`add ${plural(createdEvents, "event", "events")}`);
  if (projects) parts.push(`create ${plural(projects, "project", "projects")}`);
  if (scheduled) parts.push(`schedule ${plural(scheduled, "task", "tasks")}`);
  if (completed) parts.push(`complete ${plural(completed, "task", "tasks")}`);
  if (updated) parts.push(`update ${plural(updated, "item", "items")}`);
  if (deleted) parts.push(`delete ${plural(deleted, "item", "items")}`);
  if (dayPlan) parts.push("adjust the day");
  if (memory) parts.push("save a note");
  const text = parts.join(", ") || "update your plan";
  return text[0]!.toUpperCase() + text.slice(1);
}

export class Agent {
  private readonly runs = new Map<string, RunContext>();
  private active: { controller: AbortController; id: string } | null = null;

  constructor(private readonly deps: AgentDeps) {}

  getRun(token: string): RunContext | undefined {
    return this.runs.get(token);
  }

  get busy(): boolean {
    return this.active !== null;
  }

  provider(settings: Settings): AIProvider | null {
    if (settings.ai.provider === "off") return null;
    return this.deps.providers[settings.ai.provider] ?? null;
  }

  async status(force = false): Promise<AiStatus> {
    const settings = loadSettings(this.deps.db);
    const provider = this.provider(settings);
    const apiStatus = await this.deps.providers.anthropic_api.status(settings);
    const accounts = this.deps.accounts?.() ?? { apiService: null, chatgpt: null };
    if (!provider) {
      return {
        provider: "off",
        state: "disabled",
        billing: "none",
        message: "The assistant is turned off. Everything else in AURA keeps working.",
        detail: {},
        models: [],
        efforts: [],
        effortSupported: false,
        lastModel: null,
        rateLimit: null,
        apiKeyConfigured: apiStatus.apiKeyConfigured,
        apiConsent: apiStatus.apiConsent,
        ...accounts,
        checkedAt: new Date().toISOString(),
      };
    }
    const s = provider.id === "anthropic_api" ? apiStatus : await provider.status(settings, force);
    return { ...s, apiKeyConfigured: apiStatus.apiKeyConfigured, apiConsent: apiStatus.apiConsent, ...accounts };
  }

  cancel(): boolean {
    if (!this.active) return false;
    this.active.controller.abort();
    return true;
  }

  private domainContext(store: DbStore | OverlayStore, settings: Settings): DomainContext {
    return { store, settings, clock: this.deps.clock };
  }

  private newRun(settings: Settings, readOnly: boolean, onTool?: RunContext["onTool"]): RunContext {
    const overlay = new OverlayStore(new DbStore(this.deps.db));
    const rc: RunContext = {
      id: newId("run", 10),
      token: randomBytes(24).toString("hex"),
      overlay,
      ctx: this.domainContext(overlay, settings),
      readOnly,
      toolCalls: [],
      plans: [],
      maxToolCalls: MAX_TOOL_CALLS,
      closed: false,
      ...(onTool ? { onTool } : {}),
    };
    this.runs.set(rc.token, rc);
    return rc;
  }

  private closeRun(rc: RunContext) {
    rc.closed = true;
    this.runs.delete(rc.token);
  }

  private ensureRecurring(settings: Settings) {
    const db = this.deps.db;
    db.tx(() => {
      const ctx = this.domainContext(new DbStore(db), settings);
      const today = localNow(ctx).date;
      materializeRecurring(ctx, today, addDays(today, 14));
    });
  }

  async chat(input: ChatInput, emit: (e: ChatStreamEvent) => void): Promise<void> {
    const db = this.deps.db;
    const settings = loadSettings(db);
    const provider = this.provider(settings);
    if (!provider) throw new DomainError("invalid_state", "The assistant is turned off in Settings.");
    if (this.active) throw new DomainError("conflict", "AURA is still working on your previous request.");
    const message = input.message.trim();
    if (!message) throw new DomainError("validation", "Write a message first.");
    if (message.length > 8000) throw new DomainError("validation", "That message is too long (8,000 characters max).");

    const controller = new AbortController();
    this.active = { controller, id: newId("act") };
    const started = Date.now();
    let rc: RunContext | null = null;
    let routing: RoutingDecision | null = null;
    try {
      let userMessage: ChatMessage;
      let history: ChatMessage[];
      const all = recentMessages(db, 200);
      if (input.retryOf) {
        const original = getMessage(db, input.retryOf);
        if (!original || original.role !== "user") throw new DomainError("not_found", "The message to retry no longer exists.");
        userMessage = original;
        history = all.filter((m) => m.createdAt < original.createdAt);
      } else {
        history = all;
        userMessage = addMessage(db, "user", message);
      }
      const autoModel = (!input.model || input.model === "auto") && settings.ai.modelMode === "auto";
      routing = routeRequest(userMessage.content, settings, { model: input.model, effort: input.effort });
      if (provider.describeRoute) routing = provider.describeRoute(routing, autoModel);
      emit({ type: "accepted", userMessage, routing });

      this.ensureRecurring(settings);
      rc = this.newRun(settings, false, (t) => emit({ type: "tool", name: t.name, ok: t.ok, ...(t.error ? { error: t.error } : {}) }));
      const proposalIds = history.map((m) => m.meta.proposalId).filter((x): x is string => Boolean(x));
      const proposals = new Map(listProposals(db, proposalIds).map((p) => [p.id, p]));
      const prompt = buildPrompt(rc.ctx, userMessage.content, history, proposals, settings.ai.historyTurns);

      const result = await provider.run(
        {
          system: SYSTEM_PROMPT,
          prompt,
          model: routing.model,
          ...(autoModel ? { level: routing.level } : {}),
          effort: routing.effort as Effort | null,
          run: rc,
          timeoutMs: settings.ai.timeoutSec * 1000,
          signal: controller.signal,
          onEvent: (e) => emit(e.type === "text" ? { type: "text", delta: e.delta } : { type: "status", text: e.text }),
        },
        settings,
      );
      this.closeRun(rc);

      const changes = rc.overlay.getChanges();
      let proposal: Proposal | null = null;
      if (changes.length > 0) {
        const classification = classifyChanges(changes);
        const requiresApproval = classification.requiresApproval || settings.ai.autoApply === "never";
        const nowIso = this.deps.clock().toISOString();
        proposal = createProposal(db, {
          messageId: null,
          source: "ai",
          summary: "",
          reason: classification.reason,
          requiresApproval,
          changes,
          preview: rc.plans.length ? { plans: rc.plans } : null,
          createdAt: nowIso,
        });
        const summary = summarizeItems(proposal.items);
        db.run("UPDATE proposals SET summary = ? WHERE id = ?", summary, proposal.id);
        proposal = getProposal(db, proposal.id)!;
        if (!requiresApproval) {
          try {
            proposal = applyProposal(db, proposal.id, { auto: true, nowIso });
          } catch (err) {
            log.warn("auto-apply failed", { error: (err as Error).message });
            proposal = getProposal(db, proposal.id);
          }
        }
      }

      const meta: MessageMeta = {
        status: "ok",
        kind: "chat",
        provider: provider.id,
        billing: provider.billing,
        model: result.model ?? routing.model,
        effort: routing.effort,
        effortApplied: result.effortApplied,
        routing,
        toolCalls: rc.toolCalls,
        durationMs: Date.now() - started,
        ...(result.usage ? { usage: result.usage } : {}),
        ...(proposal ? { proposalId: proposal.id } : {}),
        ...(input.retryOf ? { retryOf: input.retryOf } : {}),
      };
      const text = result.text.trim() || (proposal ? "I've prepared the changes below." : "Done.");
      const assistant = addMessage(db, "assistant", text, meta);
      if (proposal) {
        linkProposalMessage(db, proposal.id, assistant.id);
        proposal = getProposal(db, proposal.id);
      }
      emit({ type: "done", message: assistant, proposal });
    } catch (err) {
      if (rc) this.closeRun(rc);
      const pe =
        err instanceof ProviderError
          ? err
          : err instanceof DomainError
            ? new ProviderError("unknown", err.message)
            : new ProviderError("unknown", "Something went wrong while talking to Claude. Your data was not changed.", "retry");
      if (!(err instanceof ProviderError)) log.error("agent run failed", { error: (err as Error)?.message });
      if (err instanceof DomainError && (err.code === "conflict" || err.code === "validation" || err.code === "not_found") && !routing) throw err;
      const meta: MessageMeta = {
        status: "error",
        kind: "chat",
        provider: provider.id,
        billing: provider.billing,
        error: { code: pe.code, message: pe.message, ...(pe.suggestion ? { suggestion: pe.suggestion } : {}) },
        ...(routing ? { routing, effort: routing.effort } : {}),
        toolCalls: rc?.toolCalls ?? [],
        durationMs: Date.now() - started,
        ...(input.retryOf ? { retryOf: input.retryOf } : {}),
      };
      const assistant = addMessage(db, "assistant", pe.message, meta);
      emit({ type: "error", message: assistant });
    } finally {
      this.active = null;
    }
  }

  /** Read-only run that writes a short overview of a day (cached on the day plan). */
  async brief(date: string): Promise<{ text: string; model: string }> {
    const db = this.deps.db;
    const settings = loadSettings(db);
    const provider = this.provider(settings);
    if (!provider) throw new DomainError("invalid_state", "The assistant is turned off in Settings.");
    if (this.active) throw new DomainError("conflict", "AURA is busy with another request.");
    const controller = new AbortController();
    this.active = { controller, id: newId("act") };
    const rc = this.newRun(settings, true);
    try {
      this.ensureRecurring(settings);
      const prompt = buildPrompt(rc.ctx, `${BRIEF_PROMPT}\nDay: ${date}.`, [], new Map(), 0);
      const result = await provider.run(
        {
          system: SYSTEM_PROMPT,
          prompt,
          model:
            settings.ai.modelMode === "opus" || settings.ai.modelMode === "haiku"
              ? settings.ai.modelMode
              : settings.ai.modelMode === "custom" && settings.ai.customModel
                ? settings.ai.customModel
                : "sonnet",
          effort: "low",
          run: rc,
          timeoutMs: Math.min(settings.ai.timeoutSec, 120) * 1000,
          signal: controller.signal,
          onEvent: () => undefined,
        },
        settings,
      );
      const text = result.text.trim();
      if (!text) throw new ProviderError("invalid_output", "Claude returned an empty overview.", "retry");
      const model = result.model ?? "sonnet";
      db.tx(() => {
        patchDayPlan(this.domainContext(new DbStore(db), settings), date, { aiBrief: { text, model, createdAt: this.deps.clock().toISOString() } });
      });
      return { text, model };
    } finally {
      this.closeRun(rc);
      this.active = null;
    }
  }
}
