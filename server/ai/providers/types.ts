import type { AiStatus, ComplexityLevel, RoutingDecision } from "../../../shared/api";
import type { Effort, Settings } from "../../../shared/schemas";
import type { RunContext } from "../tools";

export type ProviderErrorCode =
  | "not_installed"
  | "not_logged_in"
  | "api_key_auth"
  | "needs_consent"
  | "missing_key"
  | "rate_limit"
  | "auth"
  | "billing"
  | "model_unavailable"
  | "overloaded"
  | "timeout"
  | "cancelled"
  | "network"
  | "invalid_output"
  | "refused"
  | "tools_unavailable"
  | "unknown";

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly suggestion?: "switch_to_api" | "login" | "install" | "retry" | "settings",
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export type ProviderEvent = { type: "status"; text: string } | { type: "text"; delta: string };

export interface ProviderRunRequest {
  system: string;
  prompt: string;
  /** Alias ("sonnet", "opus") or a full model id. */
  model: string;
  /** Set when the model was chosen automatically: a service with two fixed models uses its stronger one for complex requests. */
  level?: ComplexityLevel;
  effort: Effort | null;
  run: RunContext;
  timeoutMs: number;
  signal: AbortSignal;
  onEvent: (e: ProviderEvent) => void;
}

export interface ProviderRunResult {
  text: string;
  model: string | null;
  effortApplied: boolean;
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null } | null;
}

export interface AIProvider {
  readonly id: "claude_code" | "anthropic_api" | "chatgpt";
  readonly billing: "subscription" | "api";
  status(settings: Settings, force?: boolean): Promise<AiStatus>;
  run(req: ProviderRunRequest, settings: Settings): Promise<ProviderRunResult>;
  /** Adjust the routing shown to the user to what the provider really uses (`auto`: the model was chosen automatically). */
  describeRoute?(routing: RoutingDecision, auto: boolean): RoutingDecision;
}
