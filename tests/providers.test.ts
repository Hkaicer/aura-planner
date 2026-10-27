import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AiStatus, ChatStreamEvent } from "../shared/api";
import { createApp, type AppHandle } from "../server/app";
import { ChatGptAuth, type Fetch } from "../server/ai/chatgpt/auth";
import { loadConfig } from "../server/config";
import { SecretStore } from "../server/secrets";
import { clockAt, TZ } from "./helpers";

const clock = clockAt("2026-10-27T10:00");
const nowSec = () => Math.floor(clock().getTime() / 1000);

// A stand-in for OpenAI: sign-in endpoints, published keys, the model list and the Responses API.
function fakeOpenAI() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
  const calls: { url: string; body: string }[] = [];
  const state = { nonce: "", refreshes: 0, revoked: false, responses: [] as string[] };

  const idToken = (aud: string) => {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const head = enc({ alg: "RS256", kid: "k1", typ: "JWT" });
    const body = enc({ iss: "https://auth.openai.com", aud, sub: "user-1", email: "sam@example.com", nonce: state.nonce, exp: nowSec() + 3600, iat: nowSec() });
    return `${head}.${body}.${sign("sha256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}`;
  };
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

  const fetchFn: Fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? String(init.body) : "";
    calls.push({ url, body });
    if (url.endsWith("/.well-known/openid-configuration")) {
      return json({ issuer: "https://auth.openai.com", jwks_uri: "https://auth.openai.com/.well-known/jwks.json", revocation_endpoint: "https://auth.openai.com/oauth/revoke" });
    }
    if (url.endsWith("/.well-known/jwks.json")) return json({ keys: [jwk] });
    if (url.endsWith("/oauth/token")) {
      const form = new URLSearchParams(body);
      if (form.get("grant_type") === "refresh_token") {
        state.refreshes++;
        return json({ access_token: `at-${state.refreshes + 1}`, refresh_token: `rt-${state.refreshes + 1}`, expires_in: 3600, scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct" });
      }
      return json({
        access_token: "at-1",
        refresh_token: "rt-1",
        id_token: idToken(form.get("client_id")!),
        expires_in: 3600,
        scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      });
    }
    if (url.endsWith("/oauth/revoke")) {
      state.revoked = true;
      return new Response("", { status: 200 });
    }
    if (url.endsWith("/v1/models")) return json({ data: [{ slug: "gpt-test-1", display_name: "GPT Test", visibility: "list" }, { slug: "hidden", visibility: "hide" }] });
    if (url.endsWith("/v1/responses")) {
      const sse = state.responses.shift();
      if (!sse) return json({ error: { code: "unexpected", message: "no response queued" } }, 500);
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    }
    return json({ error: "not found" }, 404);
  };
  return { fetchFn, calls, state };
}

const sse = (...events: object[]) => events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

/** Follow the sign-in as the browser would: open the authorize link, then come back with a code. */
function authorizeParams(url: string) {
  const u = new URL(url);
  expect(u.origin + u.pathname).toBe("https://auth.openai.com/api/accounts/authorize");
  return u.searchParams;
}

const handles: AppHandle[] = [];
const dirs: string[] = [];

async function boot(extra: Partial<Parameters<typeof createApp>[0]> = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-test-"));
  dirs.push(dataDir);
  const h = await createApp({ config: { ...loadConfig(), dataDir, webDir: path.join(dataDir, "no-web") }, clock, ...extra });
  await h.app.inject({ method: "PATCH", url: "/api/settings", payload: { timeZone: TZ, language: "en" } });
  handles.push(h);
  return { h, dataDir };
}

afterEach(async () => {
  for (const h of handles.splice(0)) {
    await h.app.close();
    h.db.close();
  }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("API key saved in Settings", () => {
  it("keeps the key in the secrets file only, and asks for consent again when the service changes", async () => {
    const checked: string[] = [];
    const { h, dataDir } = await boot({ verifyKey: async (service) => (checked.push(service), "ok") });
    const claudeKey = "sk-ant-api03-" + "a".repeat(40);

    const saved = await h.app.inject({ method: "POST", url: "/api/ai/key", payload: { key: claudeKey } });
    expect(saved.json()).toEqual({ service: "anthropic", verified: true });
    const consent = await h.app.inject({ method: "POST", url: "/api/settings/api-consent", payload: { granted: true, acknowledgement: "billed-separately" } });
    expect(consent.json().ai.provider).toBe("anthropic_api");
    let status = (await h.app.inject({ method: "GET", url: "/api/ai/status" })).json() as AiStatus;
    expect(status).toMatchObject({ provider: "anthropic_api", apiService: "anthropic", apiKeyConfigured: true });

    // Nowhere but the secrets file: not in the database export, not in the status.
    expect(fs.readFileSync(path.join(dataDir, "secrets.json"), "utf8")).toContain(claudeKey);
    const exported = await h.app.inject({ method: "GET", url: "/api/data/export" });
    expect(exported.body).not.toContain(claudeKey);
    expect(JSON.stringify(status)).not.toContain(claudeKey);

    // A DeepSeek key replaces it: the consent was for Anthropic, so the assistant goes off.
    const deepseek = await h.app.inject({ method: "POST", url: "/api/ai/key", payload: { key: "sk-" + "0123456789abcdef".repeat(2) } });
    expect(deepseek.json().service).toBe("deepseek");
    expect(checked).toEqual(["anthropic", "deepseek"]);
    const settings = (await h.app.inject({ method: "GET", url: "/api/settings" })).json();
    expect(settings.ai).toMatchObject({ provider: "off", apiBillingConsentAt: null });

    const removed = await h.app.inject({ method: "DELETE", url: "/api/ai/key" });
    expect(removed.json()).toEqual({ removed: true });
    status = (await h.app.inject({ method: "GET", url: "/api/ai/status" })).json() as AiStatus;
    expect(status).toMatchObject({ apiService: null, apiKeyConfigured: false });
  });

  it("refuses subscription tokens and keys the service rejects", async () => {
    const { h } = await boot({ verifyKey: async () => "rejected" });
    const token = await h.app.inject({ method: "POST", url: "/api/ai/key", payload: { key: "sk-ant-oat01-" + "b".repeat(40) } });
    expect(token.statusCode).toBe(400);
    expect(token.json().error.message).toContain("subscription token");
    const rejected = await h.app.inject({ method: "POST", url: "/api/ai/key", payload: { key: "sk-ant-api03-" + "c".repeat(40) } });
    expect(rejected.json().error.message).toContain("refused this key");
  });
});

describe("ChatGPT plan", () => {
  it("signs in through OpenAI's page, then answers with the plan and AURA's tools", async () => {
    const openai = fakeOpenAI();
    const { h } = await boot({ fetch: openai.fetchFn });

    const { url } = (await h.app.inject({ method: "POST", url: "/api/chatgpt/login", payload: {} })).json() as { url: string };
    const params = authorizeParams(url);
    expect(params.get("client_id")).toBe("dynamic_agent_client");
    expect(params.get("scope")).toContain("chatgpt.tokens.use.direct");
    expect(params.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/chatgpt\/callback$/);
    expect(params.get("code_challenge_method")).toBe("S256");
    openai.state.nonce = params.get("nonce")!;

    const back = await h.app.inject({ method: "GET", url: `/auth/chatgpt/callback?code=c1&state=${params.get("state")}&client_id=oaiapp_test` });
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toBe("/#/settings?section=assistant&chatgpt=welcome");
    const exchange = new URLSearchParams(openai.calls.find((c) => c.url.endsWith("/oauth/token"))!.body);
    expect(exchange.get("client_id")).toBe("oaiapp_test");
    expect(exchange.get("code_verifier")).toBeTruthy();

    const status = (await h.app.inject({ method: "GET", url: "/api/ai/status" })).json() as AiStatus;
    expect(status).toMatchObject({ provider: "chatgpt", state: "ready", chatgpt: { email: "sam@example.com", planUsage: true } });
    expect(JSON.stringify(status)).not.toContain("at-1");

    // The model calls one of AURA's tools, then answers.
    openai.state.responses.push(
      sse(
        { type: "response.output_text.delta", delta: "Let me look. " },
        { type: "response.completed", response: { model: "gpt-test-1", usage: { input_tokens: 10, output_tokens: 5 }, output: [{ type: "function_call", call_id: "call_1", name: "list_projects", arguments: "{}" }] } },
      ),
      sse(
        { type: "response.output_text.delta", delta: "You have no projects yet." },
        { type: "response.completed", response: { model: "gpt-test-1", usage: { input_tokens: 20, output_tokens: 6 }, output: [{ type: "message", content: [{ type: "output_text", text: "You have no projects yet." }] }] } },
      ),
    );
    await h.app.inject({ method: "POST", url: "/api/data/clear-demo", payload: {} });
    const res = await h.app.inject({ method: "POST", url: "/api/ai/chat", payload: { message: "What projects do I have?" } });
    const events = res.body.trim().split("\n").map((l) => JSON.parse(l) as ChatStreamEvent);
    const done = events.find((e) => e.type === "done") as Extract<ChatStreamEvent, { type: "done" }>;
    expect(done.message.content).toBe("You have no projects yet.");
    expect(done.message.meta).toMatchObject({ provider: "chatgpt", model: "gpt-test-1" });

    const requests = openai.calls.filter((c) => c.url.endsWith("/v1/responses")).map((c) => JSON.parse(c.body) as Record<string, unknown>);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ model: "gpt-test-1", store: false, stream: true });
    expect(requests[0]!.instructions).toBeTruthy();
    expect((requests[0]!.tools as { type: string; name: string }[]).some((t) => t.type === "function" && t.name === "list_projects")).toBe(true);
    const followUp = requests[1]!.input as { type?: string; call_id?: string }[];
    expect(followUp.find((i) => i.type === "function_call_output")).toMatchObject({ call_id: "call_1" });

    // Signing out revokes the sign-in with OpenAI and turns the assistant off.
    const out = await h.app.inject({ method: "POST", url: "/api/chatgpt/logout", payload: {} });
    expect(out.json()).toEqual({ revoked: true });
    expect(openai.state.revoked).toBe(true);
    const after = (await h.app.inject({ method: "GET", url: "/api/ai/status" })).json() as AiStatus;
    expect(after).toMatchObject({ provider: "off", chatgpt: null });
  });

  it("refreshes an expired access token and refuses a sign-in with a forged identity", async () => {
    const openai = fakeOpenAI();
    let now = clock().getTime();
    const auth = new ChatGptAuth(new SecretStore(null), openai.fetchFn, () => now);

    const params = authorizeParams(auth.startLogin("http://127.0.0.1:4317"));
    openai.state.nonce = params.get("nonce")!;
    await auth.finishLogin({ code: "c1", state: params.get("state")!, client_id: "oaiapp_test" });
    expect(await auth.accessToken()).toBe("at-1");

    now += 2 * 3600_000;
    expect(await auth.accessToken()).toBe("at-2");
    const refresh = new URLSearchParams(openai.calls.filter((c) => c.url.endsWith("/oauth/token")).at(-1)!.body);
    expect(refresh.get("grant_type")).toBe("refresh_token");
    expect(refresh.get("refresh_token")).toBe("rt-1");
    expect(refresh.get("client_id")).toBe("oaiapp_test");

    // A second sign-in whose identity token carries another nonce is refused.
    const again = authorizeParams(auth.startLogin("http://127.0.0.1:4317"));
    openai.state.nonce = "not-the-right-nonce";
    await expect(auth.finishLogin({ code: "c2", state: again.get("state")! })).rejects.toThrow("could not verify");
    // An unknown state (an old or forged link) is refused too.
    await expect(auth.finishLogin({ code: "c3", state: "nope" })).rejects.toThrow("expired");
  });
});
