import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { Agent } from "./ai/agent";
import { ChatGptAuth, type Fetch } from "./ai/chatgpt/auth";
import { registerMcp } from "./ai/mcp";
import { ApiKeyProvider } from "./ai/providers/apiKey";
import { ChatGptProvider } from "./ai/providers/chatgpt";
import { ClaudeCodeProvider } from "./ai/providers/claudeCode";
import { verifyKey as checkKey, type KeyCheck } from "./ai/providers/services";
import type { AIProvider } from "./ai/providers/types";
import type { ApiService } from "../shared/api";
import type { AppConfig } from "./config";
import { Database } from "./db/database";
import { errorReply } from "./httpErrors";
import { registerRoutes } from "./routes";
import { SecretStore } from "./secrets";
import type { CalendarFetcher } from "./services/calendarFeeds";

export { VERSION } from "./version";
import { VERSION } from "./version";

export interface AppOptions {
  config: AppConfig;
  db?: Database;
  providers?: { claude_code: AIProvider; anthropic_api: AIProvider; chatgpt?: AIProvider };
  clock?: () => Date;
  logger?: boolean;
  fetchCalendar?: CalendarFetcher;
  /** Where secrets are kept; null keeps them in memory (tests). Defaults to secrets.json in the data folder. */
  secretsFile?: string | null;
  /** How requests to OpenAI are made (ChatGPT sign-in and requests). */
  fetch?: Fetch;
  /** How a pasted API key is checked before it is saved. */
  verifyKey?: (service: ApiService, key: string) => Promise<KeyCheck>;
}

export interface AppHandle {
  app: FastifyInstance;
  db: Database;
  agent: Agent;
  config: AppConfig;
}

const LOCAL_NAMES = new Set(["127.0.0.1", "localhost", "::1"]);

export async function createApp(opts: AppOptions): Promise<AppHandle> {
  const { config } = opts;
  const db = opts.db ?? new Database(path.join(config.dataDir, "aura.db"));
  db.migrate();
  const clock = opts.clock ?? (() => new Date());
  const app = Fastify({ logger: false, bodyLimit: 20 * 1024 * 1024 });

  const secrets = new SecretStore(opts.secretsFile === undefined ? path.join(config.dataDir, "secrets.json") : opts.secretsFile);
  const chatgptAuth = new ChatGptAuth(secrets, opts.fetch ?? fetch, () => clock().getTime());
  const apiKeys = new ApiKeyProvider(secrets.read().apiKey ?? null);
  const providers = opts.providers ?? {
    claude_code: new ClaudeCodeProvider(path.join(config.dataDir, "agent"), (token) => `http://127.0.0.1:${config.port}/mcp/${token}`),
    anthropic_api: apiKeys,
    chatgpt: new ChatGptProvider(chatgptAuth, opts.fetch ?? fetch),
  };
  const agent = new Agent({ db, providers, clock, accounts: () => ({ apiService: apiKeys.service, chatgpt: chatgptAuth.account() }) });

  // Local-only guard: answer only requests addressed to this machine, and refuse
  // state changes coming from other websites (DNS rebinding, cross-site requests).
  app.addHook("onRequest", async (req, reply) => {
    const hostname = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
    if (!LOCAL_NAMES.has(hostname)) {
      return reply.code(403).send({ error: { code: "forbidden", message: "AURA only accepts requests addressed to this computer." } });
    }
    const origin = req.headers.origin;
    if (origin && req.method !== "GET" && req.method !== "HEAD") {
      let originHost = "";
      try {
        originHost = new URL(origin).hostname.replace(/^\[|\]$/g, "").toLowerCase();
      } catch {
        originHost = "";
      }
      if (!LOCAL_NAMES.has(originHost)) {
        return reply.code(403).send({ error: { code: "forbidden", message: "Cross-site requests are not allowed." } });
      }
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    const { status, body } = errorReply(err);
    return reply.code(status).send(body);
  });

  registerMcp(app, agent, VERSION);
  registerRoutes(app, {
    db,
    agent,
    config,
    clock,
    providers,
    secrets,
    chatgptAuth,
    // A saved key takes effect right away, without restarting AURA.
    onApiKeyChange: (saved) => {
      apiKeys.setKey(saved);
      const api = providers.anthropic_api as AIProvider & { setKey?: (s: typeof saved) => void };
      if (api !== apiKeys) api.setKey?.(saved);
    },
    verifyKey: opts.verifyKey ?? checkKey,
    ...(opts.fetchCalendar ? { fetchCalendar: opts.fetchCalendar } : {}),
  });

  if (fs.existsSync(config.webDir)) {
    await app.register(fastifyStatic, { root: config.webDir, prefix: "/" });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api") || req.url.startsWith("/mcp")) {
        return reply.code(404).send({ error: { code: "not_found", message: "Unknown endpoint." } });
      }
      return reply.sendFile("index.html");
    });
  } else {
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api") || req.url.startsWith("/mcp")) {
        return reply.code(404).send({ error: { code: "not_found", message: "Unknown endpoint." } });
      }
      return reply
        .type("text/html")
        .send("<p style='font-family:sans-serif'>The AURA interface has not been built yet. Run <code>npm run build</code>, or use <code>npm run dev</code> during development.</p>");
    });
  }

  return { app, db, agent, config };
}
