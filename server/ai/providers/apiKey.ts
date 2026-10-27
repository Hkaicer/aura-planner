import type { AiStatus, ApiService, RoutingDecision } from "../../../shared/api";
import type { Settings } from "../../../shared/schemas";
import type { SavedApiKey } from "../../secrets";
import { AnthropicApiProvider } from "./anthropicApi";
import { SERVICES } from "./services";
import type { AIProvider, ProviderRunRequest, ProviderRunResult } from "./types";

const build = (saved: SavedApiKey | null) => new AnthropicApiProvider(saved?.key ?? null, { service: SERVICES[saved?.service ?? "anthropic"] });

/** The API key provider, rebuilt whenever the key saved in Settings changes (Claude or DeepSeek). */
export class ApiKeyProvider implements AIProvider {
  readonly id = "anthropic_api" as const;
  readonly billing = "api" as const;
  private inner: AnthropicApiProvider;
  private saved: SavedApiKey | null;

  constructor(saved: SavedApiKey | null) {
    this.saved = saved;
    this.inner = build(saved);
  }

  get service(): ApiService | null {
    return this.saved?.service ?? null;
  }

  setKey(saved: SavedApiKey | null) {
    this.saved = saved;
    this.inner = build(saved);
  }

  async status(settings: Settings): Promise<AiStatus> {
    return { ...(await this.inner.status(settings)), apiService: this.service };
  }

  run(req: ProviderRunRequest, settings: Settings): Promise<ProviderRunResult> {
    return this.inner.run(req, settings);
  }

  describeRoute(routing: RoutingDecision, auto: boolean): RoutingDecision {
    // With a Claude key, the automatic choice sends simple requests to Haiku, which costs far less.
    if (this.saved?.service === "anthropic" && auto && routing.level === "simple" && routing.model === "sonnet") {
      return { ...routing, model: "haiku", modelLabel: "Haiku" };
    }
    return this.inner.describeRoute(routing, auto);
  }
}
