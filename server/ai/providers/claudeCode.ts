// Claude subscription provider.
//
// Runs the official, unmodified Claude Code CLI in non-interactive mode
// (`claude -p`), signed in with the user's own Claude plan. This is ordinary,
// individual use of Claude Code: AURA never reads, stores or forwards Claude
// credentials, and it refuses to run if the CLI would bill an API key.
//
// The CLI gets no built-in tools (no shell, no file access); its only tools are
// AURA's validated planning tools, served over a loopback MCP endpoint that is
// bound to a single request by an unguessable token.

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AiStatus, RateWindow } from "../../../shared/api";
import type { Settings } from "../../../shared/schemas";
import { log } from "../../logger";
import { ProviderError, type AIProvider, type ProviderRunRequest, type ProviderRunResult } from "./types";

const execFileAsync = promisify(execFile);

/** Environment variables passed to the CLI. Anything Anthropic- or Claude-specific is withheld. */
const ENV_ALLOW = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "SystemDrive",
  "USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP",
  "USERNAME", "USERDOMAIN", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432",
  "CommonProgramFiles", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "LANG", "LC_ALL",
  "TERM", "XDG_CONFIG_HOME", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy",
  "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
];

export function cliEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOW) if (source[key] !== undefined) env[key] = source[key];
  // Never let a stray key switch the CLI to separately billed API usage.
  for (const key of Object.keys(env)) if (/^(ANTHROPIC|CLAUDE)/i.test(key)) delete env[key];
  // No telemetry, error reporting, auto-updates or other nonessential traffic from AURA's runs.
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.DISABLE_AUTOUPDATER = "1";
  env.MCP_TIMEOUT = "15000";
  return env;
}

function candidatePaths(configured: string): string[] {
  const home = os.homedir();
  const list: string[] = [];
  if (configured) list.push(configured);
  const pathDirs = (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter).filter(Boolean);
  const names = process.platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
  for (const dir of pathDirs) for (const n of names) list.push(path.join(dir, n));
  if (process.platform === "win32") {
    list.push(path.join(home, ".local", "bin", "claude.exe"));
    if (process.env.APPDATA) list.push(path.join(process.env.APPDATA, "npm", "claude.cmd"));
  } else {
    list.push(path.join(home, ".local", "bin", "claude"), "/usr/local/bin/claude", "/opt/homebrew/bin/claude");
  }
  return list;
}

export function findClaudeBinary(configured: string): string | null {
  for (const p of candidatePaths(configured)) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      // not there
    }
  }
  return null;
}

function needsShell(bin: string) {
  return /\.(cmd|bat)$/i.test(bin);
}

function quote(arg: string) {
  return /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

interface AuthInfo {
  loggedIn: boolean;
  authMethod: string | null;
  subscriptionType: string | null;
}

interface RateState {
  fiveHour: RateWindow | null;
  sevenDay: RateWindow | null;
  status: string | null;
  updatedAt: string | null;
}

export class ClaudeCodeProvider implements AIProvider {
  readonly id = "claude_code" as const;
  readonly billing = "subscription" as const;
  private cache: { at: number; status: AiStatus } | null = null;
  private lastModel: string | null = null;
  private rate: RateState = { fiveHour: null, sevenDay: null, status: null, updatedAt: null };

  constructor(
    private readonly workDir: string,
    private readonly mcpUrl: (token: string) => string,
  ) {}

  private async exec(bin: string, args: string[], timeout = 15000) {
    if (needsShell(bin)) {
      return execFileAsync(`${quote(bin)} ${args.map(quote).join(" ")}`, { shell: true, timeout, env: cliEnvironment(), windowsHide: true });
    }
    return execFileAsync(bin, args, { timeout, env: cliEnvironment(), windowsHide: true });
  }

  async status(settings: Settings, force = false): Promise<AiStatus> {
    if (!force && this.cache && Date.now() - this.cache.at < 60_000) {
      return { ...this.cache.status, lastModel: this.lastModel, rateLimit: { ...this.rate } };
    }
    const base: Omit<AiStatus, "state" | "message"> = {
      provider: "claude_code",
      billing: "subscription",
      detail: {},
      models: [
        { id: "sonnet", label: "Sonnet (latest)", family: "sonnet" },
        { id: "opus", label: "Opus (latest)", family: "opus" },
      ],
      efforts: ["low", "medium", "high", "xhigh"],
      effortSupported: true,
      lastModel: this.lastModel,
      rateLimit: { ...this.rate },
      apiKeyConfigured: false,
      apiConsent: false,
      apiService: null,
      chatgpt: null,
      checkedAt: new Date().toISOString(),
    };
    const bin = findClaudeBinary(settings.ai.claudePath);
    let status: AiStatus;
    if (!bin) {
      status = {
        ...base,
        state: "not_installed",
        message: "Claude Code is not installed or not on PATH. Install it, sign in with your Claude account, then check again.",
      };
    } else {
      try {
        const { stdout: version } = await this.exec(bin, ["--version"]);
        base.detail.version = version.trim().split(/\s+/)[0] ?? null;
        base.detail.binary = bin;
        const auth = await this.auth(bin);
        if (!auth.loggedIn) {
          status = { ...base, state: "not_logged_in", message: "Claude Code is installed but not signed in. Run `claude auth login` and sign in with your Claude account." };
        } else if (auth.authMethod !== "claude.ai") {
          status = {
            ...base,
            billing: "api",
            state: "api_key_auth",
            message:
              "Claude Code is signed in with an API key or Console account, which would bill API usage separately. AURA will not use it. Sign in with your Claude subscription instead (`claude auth login`).",
          };
          base.detail.authMethod = auth.authMethod;
        } else {
          base.detail.plan = auth.subscriptionType;
          status = {
            ...base,
            state: "ready",
            message: `Connected through Claude Code with your Claude ${auth.subscriptionType ? auth.subscriptionType[0]!.toUpperCase() + auth.subscriptionType.slice(1) : ""} subscription.`.replace("  ", " "),
          };
        }
      } catch (err) {
        log.warn("claude status check failed", { error: (err as Error).message.slice(0, 200) });
        status = { ...base, state: "error", message: "Claude Code did not respond to a status check. Try again, or run `claude doctor` in a terminal." };
      }
    }
    this.cache = { at: Date.now(), status };
    return status;
  }

  private async auth(bin: string): Promise<AuthInfo> {
    try {
      const { stdout } = await this.exec(bin, ["auth", "status", "--json"]);
      const j = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
      return { loggedIn: Boolean(j.loggedIn), authMethod: j.authMethod ?? null, subscriptionType: j.subscriptionType ?? null };
    } catch (err) {
      const stdout = (err as { stdout?: string }).stdout;
      if (stdout) {
        try {
          const j = JSON.parse(stdout) as { loggedIn?: boolean };
          return { loggedIn: Boolean(j.loggedIn), authMethod: null, subscriptionType: null };
        } catch {
          // ignore
        }
      }
      throw err;
    }
  }

  invalidate() {
    this.cache = null;
  }

  async run(req: ProviderRunRequest, settings: Settings): Promise<ProviderRunResult> {
    const status = await this.status(settings);
    if (status.state !== "ready") {
      throw new ProviderError(
        status.state === "not_installed" ? "not_installed" : status.state === "not_logged_in" ? "not_logged_in" : status.state === "api_key_auth" ? "api_key_auth" : "unknown",
        status.message,
        status.state === "not_installed" ? "install" : status.state === "error" ? "retry" : "login",
      );
    }
    const bin = String(status.detail.binary);
    const runDir = path.join(this.workDir, "runs", req.run.id);
    fs.mkdirSync(runDir, { recursive: true });
    const systemFile = path.join(runDir, "system.md");
    const mcpFile = path.join(runDir, "mcp.json");
    const settingsFile = path.join(runDir, "settings.json");
    fs.writeFileSync(systemFile, req.system, "utf8");
    // Keep the user's own instruction files and auto memory out of AURA's requests.
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({ claudeMdExcludes: ["**/CLAUDE.md", "**/CLAUDE.local.md", "**/.claude/rules/**"], autoMemoryEnabled: false }),
      "utf8",
    );
    fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { aura: { type: "http", url: this.mcpUrl(req.run.token) } } }), "utf8");

    const args = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model", req.model,
      ...(req.effort ? ["--effort", req.effort] : []),
      "--system-prompt-file", systemFile,
      "--mcp-config", mcpFile,
      "--strict-mcp-config",
      "--tools", "",
      "--allowedTools", "mcp__aura",
      "--permission-mode", "dontAsk",
      "--permission-prompts", "none",
      "--no-session-persistence",
      // Skip user-level settings and hooks (--safe-mode would also drop --mcp-config).
      "--setting-sources", "project",
      "--settings", settingsFile,
      "--disable-slash-commands",
    ];

    const started = Date.now();
    return await new Promise<ProviderRunResult>((resolve, reject) => {
      const child = needsShell(bin)
        ? spawn(`${quote(bin)} ${args.map((a) => (a === "" ? '""' : quote(a))).join(" ")}`, { cwd: runDir, env: cliEnvironment(), shell: true, windowsHide: true })
        : spawn(bin, args, { cwd: runDir, env: cliEnvironment(), windowsHide: true });

      let buffer = "";
      let stderr = "";
      let finalText: string | null = null;
      let resultError: string | null = null;
      let resolvedModel: string | null = null;
      let retryError: string | null = null;
      let usage: ProviderRunResult["usage"] = null;
      let settled = false;
      let partial = "";

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.signal.removeEventListener("abort", onAbort);
        try {
          fs.rmSync(runDir, { recursive: true, force: true });
        } catch {
          // best effort
        }
        fn();
      };
      const fail = (err: ProviderError) => {
        try {
          child.kill();
        } catch {
          // already gone
        }
        finish(() => reject(err));
      };
      const onAbort = () => fail(new ProviderError("cancelled", "The request was cancelled."));
      req.signal.addEventListener("abort", onAbort);
      const timer = setTimeout(
        () => fail(new ProviderError("timeout", `Claude did not finish within ${Math.round(req.timeoutMs / 1000)} seconds.`, "retry")),
        req.timeoutMs,
      );

      const handle = (line: string) => {
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        const type = ev.type;
        if (type === "system" && ev.subtype === "init") {
          resolvedModel = typeof ev.model === "string" ? ev.model : null;
          if (ev.apiKeySource && ev.apiKeySource !== "none") {
            fail(new ProviderError("api_key_auth", "Claude Code tried to use an API key, which would be billed separately. AURA stopped the request.", "login"));
            return;
          }
          const servers = (ev.mcp_servers as { name: string; status: string }[] | undefined) ?? [];
          const aura = servers.find((s) => s.name === "aura");
          if (!aura || aura.status === "failed") {
            log.warn("aura MCP server not connected", { servers: JSON.stringify(servers), errors: JSON.stringify(ev.mcp_server_errors ?? null) });
            fail(new ProviderError("tools_unavailable", "Claude could not connect to AURA's planning tools.", "retry"));
            return;
          }
          req.onEvent({ type: "status", text: "thinking" });
        } else if (type === "stream_event") {
          const event = ev.event as { type?: string; delta?: { type?: string; text?: string }; content_block?: { type?: string } } | undefined;
          if (event?.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
            partial += event.delta.text;
            req.onEvent({ type: "text", delta: event.delta.text });
          } else if (event?.type === "message_start" && partial) {
            partial = "";
            req.onEvent({ type: "status", text: "continuing" });
          }
        } else if (type === "rate_limit_event") {
          const info = ev.rate_limit_info as
            | { status?: string; unifiedWindows?: { five_hour?: RateWindow; seven_day?: RateWindow } }
            | undefined;
          if (info) {
            this.rate = {
              status: info.status ?? null,
              fiveHour: info.unifiedWindows?.five_hour ?? this.rate.fiveHour,
              sevenDay: info.unifiedWindows?.seven_day ?? this.rate.sevenDay,
              updatedAt: new Date().toISOString(),
            };
          }
        } else if (type === "system" && ev.subtype === "api_retry") {
          retryError = typeof ev.error === "string" ? ev.error : null;
          req.onEvent({ type: "status", text: retryError === "rate_limit" ? "rate limited, retrying" : "retrying" });
        } else if (type === "result") {
          const u = ev.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
          usage = u
            ? {
                inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
                outputTokens: u.output_tokens ?? 0,
                costUsd: null,
              }
            : null;
          if (ev.is_error) resultError = typeof ev.result === "string" ? ev.result : String(ev.subtype ?? "error");
          else finalText = typeof ev.result === "string" ? ev.result : "";
        }
      };

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (line) handle(line);
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-4000);
      });
      child.on("error", (err) => fail(new ProviderError("not_installed", `Could not start Claude Code: ${err.message}`, "install")));
      child.on("close", (code) => {
        if (buffer.trim()) handle(buffer.trim());
        if (settled) return;
        if (resolvedModel) this.lastModel = resolvedModel;
        log.info("claude run finished", { code, ms: Date.now() - started, model: resolvedModel, tools: req.run.toolCalls.length });
        if (finalText !== null) {
          finish(() => resolve({ text: finalText!, model: resolvedModel, effortApplied: Boolean(req.effort), usage }));
          return;
        }
        const message = resultError ?? (stderr.trim().split("\n").slice(-3).join(" ") || `Claude Code exited with code ${code}.`);
        finish(() => reject(classifyCliError(message, retryError)));
      });

      child.stdin.on("error", () => undefined);
      child.stdin.end(req.prompt, "utf8");
    });
  }
}

export function classifyCliError(message: string, retryError: string | null): ProviderError {
  const m = message.toLowerCase();
  if (retryError === "rate_limit" || /usage limit|rate limit|too many requests|limit reached|out of extra usage/.test(m)) {
    return new ProviderError(
      "rate_limit",
      "Your Claude subscription's usage limit has been reached for now. It resets automatically; you can keep planning manually meanwhile.",
      "switch_to_api",
    );
  }
  if (retryError === "authentication_failed" || /\/login|not logged in|authentication|oauth|invalid api key|unauthorized/.test(m)) {
    return new ProviderError("auth", "Your Claude sign-in has expired or is invalid. Run `claude auth login` in a terminal, then try again.", "login");
  }
  if (retryError === "billing_error" || /billing|payment|credit/.test(m)) {
    return new ProviderError("billing", "Claude reported a billing problem with this account.", "settings");
  }
  if (retryError === "model_not_found" || /model.*(not found|not available|invalid)|does not have access/.test(m)) {
    return new ProviderError("model_unavailable", "The selected model is not available on your plan. Choose another model in Settings.", "settings");
  }
  if (retryError === "overloaded" || /overloaded|529/.test(m)) {
    return new ProviderError("overloaded", "Claude is overloaded right now. Try again in a moment.", "retry");
  }
  if (/max.?turns|error_max_turns/.test(m)) {
    return new ProviderError("invalid_output", "The request needed too many steps and was stopped. Try breaking it into smaller requests.", "retry");
  }
  if (/econn|network|fetch failed|enotfound|socket/.test(m)) {
    return new ProviderError("network", "Claude could not be reached. Check your internet connection.", "retry");
  }
  return new ProviderError("unknown", `Claude Code reported an error: ${message.slice(0, 300)}`, "retry");
}
