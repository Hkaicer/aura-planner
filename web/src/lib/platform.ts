// Which service answers the assistant, read from the AI status the server
// reports, and how the interface names its models.

import type { AiStatus } from "@shared/api";

type Status = AiStatus | undefined;

export const MANAGE_USAGE_URL = "https://chatgpt.com/settings/usage";

/** With a DeepSeek key, the two model choices are Flash and Pro instead of Sonnet and Opus. */
export const usesDeepSeek = (st: Status) => st?.provider === "anthropic_api" && st.apiService === "deepseek";

/** With a Claude API key, Haiku is offered too (and used for simple requests in automatic mode). */
export const offersHaiku = (st: Status) => st?.provider === "anthropic_api" && st.apiService === "anthropic";

/** ChatGPT uses one model for everything: the choice is about reasoning effort only. */
export const usesChatGpt = (st: Status) => st?.provider === "chatgpt";

/** Who answers, as named in "What is sent to …". */
export const assistantName = (st: Status) => (usesChatGpt(st) ? "ChatGPT" : usesDeepSeek(st) ? "DeepSeek" : "Claude");

export const modelChoiceName = (choice: "sonnet" | "opus" | "haiku", st: Status) =>
  usesDeepSeek(st) ? (choice === "opus" ? "Pro" : "Flash") : choice === "sonnet" ? "Sonnet" : choice === "opus" ? "Opus" : "Haiku";
