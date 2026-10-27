// ChatGPT plan provider.
//
// Uses the ChatGPT plan of the account AURA is signed in to (see
// chatgpt/auth.ts), through OpenAI's public Responses API. Requests count
// against that plan's usage, which the user manages in ChatGPT's settings.

import type { AiStatus, RoutingDecision } from "../../../shared/api";
import type { Effort, Settings } from "../../../shared/schemas";
import { log } from "../../logger";
import { ChatGptError, OPENAI_API, type ChatGptAuth, type Fetch } from "../chatgpt/auth";
import { executeTool, toolDefinitions } from "../tools";
import { ProviderError, type AIProvider, type ProviderRunRequest, type ProviderRunResult } from "./types";

export const MANAGE_USAGE_URL = "https://chatgpt.com/settings/usage";
const MAX_ITERATIONS = 16;

interface ChatGptModel {
  id: string;
  label: string;
}

interface OutputItem {
  type: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: { type: string; text?: string }[];
}

interface ResponseBody {
  output?: OutputItem[];
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { code?: string; message?: string } | null;
  model?: string;
}

/** AURA's effort levels, as reasoning efforts the Responses API accepts. */
const reasoningEffort = (effort: Effort | null): "low" | "medium" | "high" | null => (effort === null ? null : effort === "xhigh" ? "high" : effort);

export class ChatGptProvider implements AIProvider {
  readonly id = "chatgpt" as const;
  readonly billing = "subscription" as const;
  private models: { at: number; list: ChatGptModel[] } | null = null;
  private lastModel: string | null = null;
  /** The model the next request will use, named in the routing shown to the user. */
  private nextModel: ChatGptModel | null = null;
  /** Turned off when a model refuses the reasoning setting. */
  private reasoning = true;

  constructor(
    private readonly auth: ChatGptAuth,
    private readonly fetchFn: Fetch = fetch,
  ) {}

  /** The models the signed-in account can use, newest catalog first. */
  async listModels(force = false): Promise<ChatGptModel[]> {
    if (!force && this.models && Date.now() - this.models.at < 10 * 60_000) return this.models.list;
    const res = await this.call((token) => this.fetchFn(`${OPENAI_API}/models`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) }));
    const body = (await res.json()) as { data?: Record<string, unknown>[]; models?: Record<string, unknown>[] };
    const list = (body.data ?? body.models ?? [])
      .filter((m) => m.visibility === undefined || m.visibility === "list")
      .map((m) => {
        const id = String(m.slug ?? m.id ?? "");
        return { id, label: String(m.display_name ?? m.title ?? id) };
      })
      .filter((m) => m.id);
    this.models = { at: Date.now(), list };
    return list;
  }

  private async chosenModel(settings: Settings): Promise<ChatGptModel> {
    const list = await this.listModels();
    const wanted = settings.ai.chatgptModel;
    const model = (wanted && list.find((m) => m.id === wanted)) || list[0];
    if (!model) throw new ProviderError("model_unavailable", "Your ChatGPT account offers no model to other apps right now.", "settings");
    this.nextModel = model;
    return model;
  }

  async status(settings: Settings): Promise<AiStatus> {
    const account = this.auth.account();
    const base: AiStatus = {
      provider: "chatgpt",
      state: "ready",
      billing: "subscription",
      message: "",
      detail: {},
      models: [],
      efforts: this.reasoning ? ["low", "medium", "high"] : [],
      effortSupported: this.reasoning,
      lastModel: this.lastModel,
      rateLimit: null,
      apiKeyConfigured: false,
      apiConsent: false,
      apiService: null,
      chatgpt: account,
      checkedAt: new Date().toISOString(),
    };
    if (!account) {
      return { ...base, state: "not_logged_in", message: "AURA is not signed in to ChatGPT. Use Continue with ChatGPT in Settings > Assistant." };
    }
    if (!account.planUsage) {
      return {
        ...base,
        state: "needs_consent",
        message: "ChatGPT plan usage was not allowed when you signed in. Sign out, then continue with ChatGPT again and allow it.",
      };
    }
    try {
      const model = await this.chosenModel(settings);
      return {
        ...base,
        message: `Using your ChatGPT plan${account.email ? ` (${account.email})` : ""}.`,
        detail: { account: account.email, model: model.id },
        models: (this.models?.list ?? []).map((m) => ({ id: m.id, label: m.label, family: "other" as const })),
      };
    } catch (err) {
      const e = toProviderError(err);
      return { ...base, state: e.code === "not_logged_in" ? "not_logged_in" : "error", message: e.message };
    }
  }

  describeRoute(routing: RoutingDecision): RoutingDecision {
    // One model for everything: harder requests (or "Opus" in the chat) get more reasoning instead.
    const effort = routing.model === "opus" ? "high" : routing.effort;
    return { ...routing, model: "chatgpt", modelLabel: this.nextModel?.label ?? "ChatGPT", effort: this.reasoning ? effort : null };
  }

  async run(req: ProviderRunRequest, settings: Settings): Promise<ProviderRunResult> {
    const account = this.auth.account();
    if (!account) throw new ProviderError("not_logged_in", "AURA is not signed in to ChatGPT. Sign in again in Settings > Assistant.", "settings");
    if (!account.planUsage) throw new ProviderError("needs_consent", "ChatGPT plan usage was not allowed when you signed in. Sign in again and allow it.", "settings");
    const model = await this.chosenModel(settings);
    const effort = reasoningEffort(req.model === "opus" ? "high" : req.effort);
    const tools = toolDefinitions(req.run.readOnly).map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.inputSchema, strict: false }));
    // The whole conversation goes with each request: this flow keeps nothing on OpenAI's side (store: false).
    const input: unknown[] = [{ role: "user", content: req.prompt }];
    let inputTokens = 0;
    let outputTokens = 0;
    let finalText = "";
    req.onEvent({ type: "status", text: "thinking" });

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      if (i > 0) req.onEvent({ type: "status", text: "continuing" });
      const response = await this.respond(
        {
          model: model.id,
          instructions: req.system,
          input,
          tools,
          store: false,
          stream: true,
          include: ["reasoning.encrypted_content"],
          ...(effort && this.reasoning ? { reasoning: { effort } } : {}),
        },
        req,
      );
      inputTokens += response.usage?.input_tokens ?? 0;
      outputTokens += response.usage?.output_tokens ?? 0;
      this.lastModel = response.model ?? model.id;

      const output = response.output ?? [];
      const calls = output.filter((o) => o.type === "function_call");
      if (calls.length === 0) {
        finalText = output
          .filter((o) => o.type === "message")
          .flatMap((o) => o.content ?? [])
          .filter((c) => c.type === "output_text")
          .map((c) => c.text ?? "")
          .join("");
        break;
      }
      input.push(...output);
      for (const call of calls) {
        let args: unknown = {};
        try {
          args = JSON.parse(call.arguments || "{}");
        } catch {
          args = null;
        }
        const r = args === null ? { ok: false as const, error: "The arguments were not valid JSON." } : executeTool(req.run, call.name ?? "", args);
        input.push({ type: "function_call_output", call_id: call.call_id, output: r.ok ? JSON.stringify(r.result) : `Error: ${r.error}` });
      }
      if (i === MAX_ITERATIONS - 1) throw new ProviderError("invalid_output", "The request needed too many steps and was stopped.", "retry");
    }
    log.info("chatgpt run finished", { model: this.lastModel, inputTokens, outputTokens, tools: req.run.toolCalls.length });
    return { text: finalText, model: this.lastModel, effortApplied: Boolean(effort && this.reasoning), usage: { inputTokens, outputTokens, costUsd: null } };
  }

  /** One streamed Responses API request, with its text forwarded as it arrives. */
  private async respond(body: Record<string, unknown>, req: ProviderRunRequest): Promise<ResponseBody> {
    const timeout = AbortSignal.timeout(req.timeoutMs);
    const signal = AbortSignal.any([req.signal, timeout]);
    let res: Response;
    try {
      res = await this.call((token) =>
        this.fetchFn(`${OPENAI_API}/responses`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "text/event-stream" },
          body: JSON.stringify(body),
          signal,
        }),
      );
    } catch (err) {
      if (req.signal.aborted) throw new ProviderError("cancelled", "The request was cancelled.");
      if (timeout.aborted) throw new ProviderError("timeout", `ChatGPT did not finish within ${Math.round(req.timeoutMs / 1000)} seconds.`, "retry");
      const e = toProviderError(err);
      // Some models take no reasoning setting: try once more without it.
      if (e.code === "unknown" && this.reasoning && "reasoning" in body && /reasoning/i.test(e.message)) {
        this.reasoning = false;
        const { reasoning: _drop, ...rest } = body;
        return this.respond(rest, req);
      }
      throw e;
    }

    let completed: ResponseBody | null = null;
    try {
      for await (const event of readEvents(res)) {
        const type = event.type;
        if (type === "response.output_text.delta" && typeof event.delta === "string") {
          req.onEvent({ type: "text", delta: event.delta });
        } else if (type === "response.completed") {
          completed = event.response as ResponseBody;
        } else if (type === "response.failed") {
          const error = (event.response as ResponseBody | undefined)?.error;
          throw responseError(error?.code ?? "unknown", error?.message ?? "ChatGPT could not answer.");
        } else if (type === "response.incomplete") {
          throw new ProviderError("invalid_output", "The response was cut off before it finished.", "retry");
        } else if (type === "error") {
          throw responseError(String(event.code ?? "unknown"), String(event.message ?? "ChatGPT could not answer."));
        }
      }
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (req.signal.aborted) throw new ProviderError("cancelled", "The request was cancelled.");
      if (timeout.aborted) throw new ProviderError("timeout", `ChatGPT did not finish within ${Math.round(req.timeoutMs / 1000)} seconds.`, "retry");
      throw new ProviderError("network", "The connection to ChatGPT was interrupted. Try again.", "retry");
    }
    if (!completed) throw new ProviderError("network", "The connection to ChatGPT closed before the answer was complete. Try again.", "retry");
    return completed;
  }

  /** Make a request with a fresh access token, refreshing it once if OpenAI rejects it. */
  private async call(send: (token: string) => Promise<Response>): Promise<Response> {
    let res = await send(await this.token(false));
    if (res.status === 401) res = await send(await this.token(true));
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
      throw responseError(body.error?.code ?? `http_${res.status}`, body.error?.message ?? `OpenAI answered ${res.status}.`, res.status);
    }
    return res;
  }

  private async token(force: boolean): Promise<string> {
    try {
      return await this.auth.accessToken(force);
    } catch (err) {
      throw toProviderError(err);
    }
  }
}

/** Read a server-sent event stream as JSON events. */
async function* readEvents(res: Response): AsyncGenerator<Record<string, unknown>> {
  if (!res.body) return;
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, "");
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      try {
        yield JSON.parse(data) as Record<string, unknown>;
      } catch {
        // ignore malformed events
      }
    }
  }
}

function responseError(code: string, message: string, status?: number): ProviderError {
  switch (code) {
    case "subscription_sharing_usage_limit_exceeded":
      return new ProviderError("rate_limit", `You have used the ChatGPT plan usage available to AURA for now. Manage usage: ${MANAGE_USAGE_URL}`, "settings");
    case "subscription_sharing_usage_unavailable":
      return new ProviderError("overloaded", "ChatGPT could not check your plan usage. Try again in a moment.", "retry");
    case "subscription_sharing_user_not_eligible":
      return new ProviderError("billing", "This ChatGPT account, plan or workspace cannot be used in other apps.", "settings");
    case "subscription_sharing_invalid_user":
      return new ProviderError("auth", "ChatGPT could not validate your sign-in. Try again, or sign out and sign in again in Settings > Assistant.", "settings");
    case "model_not_found":
      return new ProviderError("model_unavailable", "This ChatGPT model is not available to your account. Choose another in Settings > Assistant.", "settings");
  }
  if (status === 429) return new ProviderError("rate_limit", "ChatGPT is limiting requests right now. Try again shortly.", "retry");
  if (status === 401) return new ProviderError("auth", "ChatGPT rejected AURA's sign-in. Sign out, then sign in again in Settings > Assistant.", "settings");
  if (status !== undefined && status >= 500) return new ProviderError("overloaded", "ChatGPT had a server error. Try again.", "retry");
  return new ProviderError("unknown", `ChatGPT error: ${message.slice(0, 200)}`, "retry");
}

function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof ChatGptError) {
    if (err.code === "network") return new ProviderError("network", err.message, "retry");
    return new ProviderError("not_logged_in", err.message, "settings");
  }
  return new ProviderError("network", "OpenAI could not be reached. Check your connection.", "retry");
}
