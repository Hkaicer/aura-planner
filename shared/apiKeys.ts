import type { KeyDetection } from "./api";

/**
 * Recognize an API key by its prefix. Claude subscription tokens (sk-ant-oat…)
 * are refused: Anthropic only allows them in its own apps. The DeepSeek pattern
 * is an observation, not a documented format, so an unknown key can still be
 * used by choosing the service by hand.
 */
export function detectService(key: string): KeyDetection {
  const k = key.trim();
  if (k.startsWith("sk-ant-oat")) return "subscription_token";
  if (k.startsWith("sk-ant-")) return "anthropic";
  if (/^sk-[0-9a-f]{32}$/i.test(k)) return "deepseek";
  return "unknown";
}

/** A loose shape check before the key is sent anywhere. */
export const looksLikeApiKey = (key: string) => /^sk-[A-Za-z0-9_-]{20,}$/.test(key.trim());
