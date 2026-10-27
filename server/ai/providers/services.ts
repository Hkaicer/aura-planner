import Anthropic from "@anthropic-ai/sdk";
import type { ApiService as ServiceId } from "../../../shared/api";
import { ANTHROPIC_API, type ApiService } from "./anthropicApi";

// The services an API key saved in Settings can belong to. Both speak the
// Anthropic message format, DeepSeek at its own address.

export const SERVICES: Record<ServiceId, ApiService> = {
  anthropic: ANTHROPIC_API,
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    assistant: "DeepSeek",
    account: "DeepSeek",
    keyName: "DeepSeek API key",
    keyHint: ANTHROPIC_API.keyHint,
    baseURL: "https://api.deepseek.com/anthropic",
    // DeepSeek has no model list: routine and moderate requests use Flash, complex ones (or "Opus" in the chat) V4 Pro.
    models: {
      routine: { id: "deepseek-flash", label: "DeepSeek Flash", family: "sonnet", createdAt: "" },
      complex: { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", family: "opus", createdAt: "" },
    },
    // Which effort values DeepSeek accepts is not documented, so none is sent.
    effort: false,
  },
};

export const SERVICE_NAMES: Record<ServiceId, string> = { anthropic: "Anthropic", deepseek: "DeepSeek" };

export type KeyCheck = "ok" | "rejected" | "unreachable";

/** Check a key with a free call: the model list (Anthropic) or the account balance (DeepSeek). */
export async function verifyKey(service: ServiceId, key: string): Promise<KeyCheck> {
  try {
    if (service === "anthropic") {
      await new Anthropic({ apiKey: key, maxRetries: 0, timeout: 15_000 }).models.list({ limit: 1 });
      return "ok";
    }
    const res = await fetch("https://api.deepseek.com/user/balance", { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 401 || res.status === 403) return "rejected";
    return res.ok ? "ok" : "unreachable";
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return "rejected";
    return "unreachable";
  }
}
