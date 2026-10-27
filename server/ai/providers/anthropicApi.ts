// API key provider (separately billed, opt-in).
//
// Used only when the user has saved an API key in Settings *and* given explicit
// consent. AURA never switches to this provider on its own. It also serves
// DeepSeek, which offers the same message format at another address (see
// ApiService and services.ts).

import Anthropic from "@anthropic-ai/sdk";
import type { AiStatus, RoutingDecision } from "../../../shared/api";
import type { Settings } from "../../../shared/schemas";
import { log } from "../../logger";
import { executeTool, toolDefinitions } from "../tools";
import { ProviderError, type AIProvider, type ProviderRunRequest, type ProviderRunResult } from "./types";

interface ModelInfo {
  id: string;
  label: string;
  family: "sonnet" | "opus" | "haiku" | "other";
  createdAt: string;
}

/** The service behind the Anthropic message format, and how AURA talks about it. */
export interface ApiService {
  /** Reported in the status, so the interface can name the models: "anthropic", "deepseek". */
  id: string;
  /** As used in sentences: "the Anthropic API", "DeepSeek". */
  label: string;
  /** Who answers: "Claude", "DeepSeek". */
  assistant: string;
  /** The account that is billed: "API", "DeepSeek". */
  account: string;
  keyName: string;
  /** Where to fix a rejected key. */
  keyHint: string;
  baseURL?: string;
  /** Two fixed models instead of the account's model list (for services without one). */
  models?: { routine: ModelInfo; complex: ModelInfo };
  /** Whether output_config.effort is sent. */
  effort: boolean;
}

export const ANTHROPIC_API: ApiService = {
  id: "anthropic",
  label: "the Anthropic API",
  assistant: "Claude",
  account: "API",
  keyName: "Anthropic API key",
  keyHint: "Check it in Settings > Assistant.",
  effort: true,
};

const MAX_ITERATIONS = 16;
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

export class AnthropicApiProvider implements AIProvider {
  readonly id = "anthropic_api" as const;
  readonly billing = "api" as const;
  private client: Anthropic | null = null;
  private models: { at: number; list: ModelInfo[] } | null = null;
  private lastModel: string | null = null;
  private readonly service: ApiService;

  constructor(
    private readonly apiKey: string | null,
    opts: { service?: ApiService } = {},
  ) {
    this.service = opts.service ?? ANTHROPIC_API;
    if (apiKey) {
      this.client = new Anthropic({
        apiKey,
        maxRetries: 2,
        timeout: 120_000,
        ...(this.service.baseURL ? { baseURL: this.service.baseURL } : {}),
      });
    }
  }

  private async listModels(): Promise<ModelInfo[]> {
    if (this.service.models) return [this.service.models.routine, this.service.models.complex];
    if (!this.client) return [];
    if (this.models && Date.now() - this.models.at < 10 * 60_000) return this.models.list;
    const list: ModelInfo[] = [];
    for await (const m of this.client.models.list({ limit: 100 })) {
      const id = m.id;
      const family = id.includes("sonnet") ? "sonnet" : id.includes("opus") ? "opus" : id.includes("haiku") ? "haiku" : "other";
      list.push({ id, label: m.display_name ?? id, family, createdAt: String(m.created_at) });
    }
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    this.models = { at: Date.now(), list };
    return list;
  }

  /** For a service with two fixed models: the one an alias uses, the stronger one for complex requests. */
  private fixedModel(alias: string, level: ProviderRunRequest["level"]): ModelInfo | null {
    const fixed = this.service.models;
    if (!fixed || (alias !== "sonnet" && alias !== "opus" && alias !== "haiku")) return null;
    return alias === "opus" || level === "complex" ? fixed.complex : fixed.routine;
  }

  /** Name the model a request will really use, and drop the effort when the service does not take one. */
  describeRoute(routing: RoutingDecision, auto: boolean): RoutingDecision {
    const fixed = this.fixedModel(routing.model, auto ? routing.level : undefined);
    if (!fixed) return routing;
    return { ...routing, modelLabel: fixed.label, effort: this.service.effort ? routing.effort : null };
  }

  /** Resolve an alias ("sonnet", "opus") to the newest model of that family the key can use. */
  private async resolveModel(alias: string, level: ProviderRunRequest["level"]): Promise<string> {
    const fixed = this.fixedModel(alias, level);
    if (fixed) return fixed.id;
    if (alias !== "sonnet" && alias !== "opus" && alias !== "haiku") return alias;
    const models = await this.listModels();
    const match = models.find((m) => m.family === alias);
    if (!match) throw new ProviderError("model_unavailable", `No ${alias} model is available to this API key.`, "settings");
    return match.id;
  }

  async status(settings: Settings): Promise<AiStatus> {
    const { label, account } = this.service;
    const base: AiStatus = {
      provider: "anthropic_api",
      state: "ready",
      billing: "api",
      message: "",
      detail: { service: this.service.id },
      models: [],
      efforts: this.service.effort ? ["low", "medium", "high", "xhigh"] : [],
      effortSupported: this.service.effort,
      lastModel: this.lastModel,
      rateLimit: null,
      apiKeyConfigured: Boolean(this.apiKey),
      apiConsent: Boolean(settings.ai.apiBillingConsentAt),
      apiService: null,
      chatgpt: null,
      checkedAt: new Date().toISOString(),
    };
    if (!this.apiKey) {
      return { ...base, state: "missing_key", message: "No API key yet. Add yours in Settings > Assistant." };
    }
    if (!settings.ai.apiBillingConsentAt) {
      return { ...base, state: "needs_consent", message: `${cap(label)} usage is billed separately from your Claude subscription. Confirm in Settings before AURA uses it.` };
    }
    try {
      const models = await this.listModels();
      return {
        ...base,
        state: "ready",
        message: `Connected to ${label}. Usage is billed to your ${account} account.`,
        models: models.filter((m) => m.family !== "other").map(({ id, label: name, family }) => ({ id, label: name, family })),
        detail: { ...base.detail, consentAt: settings.ai.apiBillingConsentAt },
      };
    } catch (err) {
      const e = mapApiError(err, this.service);
      return { ...base, state: "error", message: e.message };
    }
  }

  async run(req: ProviderRunRequest, settings: Settings): Promise<ProviderRunResult> {
    if (!this.client) throw new ProviderError("missing_key", `No ${this.service.keyName} is configured.`, "settings");
    if (!settings.ai.apiBillingConsentAt) {
      throw new ProviderError("needs_consent", "Confirm separately billed API usage in Settings first.", "settings");
    }
    const model = await this.resolveModel(req.model, req.level);
    const effort = this.service.effort ? req.effort : null;
    const tools: Anthropic.Tool[] = toolDefinitions(req.run.readOnly).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }));
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: req.prompt }];
    let inputTokens = 0;
    let outputTokens = 0;
    let finalText = "";
    req.onEvent({ type: "status", text: "thinking" });

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      let response: Anthropic.Message;
      try {
        response = await this.client.messages.create(
          {
            model,
            max_tokens: 16000,
            system: req.system,
            messages,
            tools,
            ...(effort ? { output_config: { effort } } : {}),
          },
          { signal: req.signal },
        );
      } catch (err) {
        throw mapApiError(err, this.service);
      }
      inputTokens += response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0);
      outputTokens += response.usage.output_tokens;
      this.lastModel = response.model;

      if (response.stop_reason === "refusal") throw new ProviderError("refused", `${this.service.assistant} declined this request.`);
      if (response.stop_reason === "max_tokens") throw new ProviderError("invalid_output", "The response was cut off before it finished.", "retry");

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (text) req.onEvent({ type: "text", delta: text });

      if (response.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: response.content });
        continue;
      }
      const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
        finalText = text;
        break;
      }
      messages.push({ role: "assistant", content: response.content });
      const results: Anthropic.ToolResultBlockParam[] = toolUses.map((tu) => {
        const r = executeTool(req.run, tu.name, tu.input);
        return r.ok
          ? { type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(r.result) }
          : { type: "tool_result", tool_use_id: tu.id, content: r.error, is_error: true };
      });
      messages.push({ role: "user", content: results });
      if (i === MAX_ITERATIONS - 1) throw new ProviderError("invalid_output", "The request needed too many steps and was stopped.", "retry");
    }
    log.info("api run finished", { model, inputTokens, outputTokens, tools: req.run.toolCalls.length });
    return { text: finalText, model, effortApplied: Boolean(effort), usage: { inputTokens, outputTokens, costUsd: null } };
  }
}

function mapApiError(err: unknown, service: ApiService): ProviderError {
  const label = cap(service.label);
  if (err instanceof ProviderError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return new ProviderError("cancelled", "The request was cancelled.");
  if (err instanceof Anthropic.RateLimitError) return new ProviderError("rate_limit", `${label} rate limit was reached. Try again shortly.`, "retry");
  if (err instanceof Anthropic.AuthenticationError) return new ProviderError("auth", `The ${service.keyName} was rejected. ${service.keyHint}`, "settings");
  if (err instanceof Anthropic.PermissionDeniedError) return new ProviderError("billing", "The API key is not allowed to use this model or has no credit.", "settings");
  if (err instanceof Anthropic.NotFoundError) return new ProviderError("model_unavailable", "The selected model is not available to this API key.", "settings");
  if (err instanceof Anthropic.APIConnectionError) return new ProviderError("network", `${label} could not be reached. Check your connection.`, "retry");
  if (err instanceof Anthropic.InternalServerError) return new ProviderError("overloaded", `${label} had a server error. Try again.`, "retry");
  if (err instanceof Anthropic.BadRequestError) return new ProviderError("unknown", `${label} rejected the request: ${err.message.slice(0, 200)}`, "retry");
  // DeepSeek answers 402 when the account has no balance left.
  if (err instanceof Anthropic.APIError && err.status === 402) return new ProviderError("billing", `Your ${service.account} account has no credit left.`, "settings");
  if (err instanceof Anthropic.APIError) return new ProviderError("unknown", `${label} error: ${err.message.slice(0, 200)}`, "retry");
  return new ProviderError("unknown", (err as Error)?.message?.slice(0, 200) ?? "Unknown error", "retry");
}
