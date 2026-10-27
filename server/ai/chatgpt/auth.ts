// Sign in with ChatGPT, to use the user's own ChatGPT plan.
//
// OpenAI offers ChatGPT plan usage to open-source apps and personal apps that
// run locally (https://developers.openai.com/siwc). The user signs in on
// OpenAI's own page in their browser and chooses whether AURA may use their
// plan. OpenAI then sends the browser back to AURA's loopback address with a
// code, which AURA exchanges for tokens. The tokens stay in the local secrets
// file and are only ever sent to OpenAI.

import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import type { ChatGptAccount } from "../../../shared/api";
import type { ChatGptRecord, ChatGptSession, SecretStore } from "../../secrets";

const ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
export const OPENAI_API = "https://api.openai.com/v1";
/** Identity, a refresh token, and the permission to use the user's ChatGPT plan. */
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
export const CALLBACK_PATH = "/auth/chatgpt/callback";
const LOGIN_TTL_MS = 10 * 60_000;
const REFRESH_MARGIN_MS = 5 * 60_000;
const CLOCK_SKEW_MS = 60_000;
/** Refresh errors after which the tokens can no longer be used. */
const TERMINAL_ERRORS = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"]);

export type Fetch = typeof fetch;

export class ChatGptError extends Error {
  constructor(
    readonly code: "denied" | "expired_link" | "client" | "token" | "signed_out" | "network",
    message: string,
  ) {
    super(message);
    this.name = "ChatGptError";
  }
}

interface PendingLogin {
  nonce: string;
  verifier: string;
  redirectUri: string;
  createdAt: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
}

interface Discovery {
  issuer: string;
  jwks_uri: string;
  revocation_endpoint: string | null;
}

const b64url = (buf: Buffer) => buf.toString("base64url");
const decodePart = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;

export class ChatGptAuth {
  private readonly pending = new Map<string, PendingLogin>();
  private refreshing: Promise<ChatGptSession> | null = null;
  private discovery: Discovery | null = null;

  constructor(
    private readonly secrets: SecretStore,
    private readonly fetchFn: Fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  account(): ChatGptAccount | null {
    const s = this.secrets.read().chatgpt?.session;
    return s ? { email: s.email, planUsage: s.scopes.includes(PLAN_SCOPE) } : null;
  }

  /** Start a sign-in and return OpenAI's page to open in the browser. `origin` is AURA's own address. */
  startLogin(origin: string): string {
    const record = this.record();
    const state = b64url(randomBytes(24));
    const nonce = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(32));
    const redirectUri = `${origin}${CALLBACK_PATH}`;
    for (const [key, p] of this.pending) if (this.now() - p.createdAt > LOGIN_TTL_MS) this.pending.delete(key);
    this.pending.set(state, { nonce, verifier, redirectUri, createdAt: this.now() });

    const params = new URLSearchParams({
      client_id: record.clientId ?? "dynamic_agent_client",
      ...(record.clientId ? {} : { agent_name_hint: "AURA" }),
      ext_agent_host_id: record.hostId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: SCOPES,
      resource: OPENAI_API,
      state,
      nonce,
      code_challenge: b64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
    });
    return `${AUTHORIZE_URL}?${params}`;
  }

  /** Finish a sign-in from the browser callback. `firstTime` is true for the first sign-in of this AURA install. */
  async finishLogin(query: Record<string, string | undefined>): Promise<{ firstTime: boolean; account: ChatGptAccount }> {
    if (query.error) throw new ChatGptError("denied", query.error === "access_denied" ? "The sign-in was cancelled." : `OpenAI stopped the sign-in (${query.error}).`);
    const pending = query.state ? this.pending.get(query.state) : undefined;
    if (!pending || this.now() - pending.createdAt > LOGIN_TTL_MS) throw new ChatGptError("expired_link", "This sign-in link has expired. Start again from AURA's settings.");
    this.pending.delete(query.state!);
    if (!query.code) throw new ChatGptError("token", "OpenAI did not return a sign-in code.");

    const record = this.record();
    const firstTime = !record.clientId;
    let clientId = record.clientId;
    if (!clientId) {
      // A first sign-in registers this install with OpenAI, which returns its client id.
      if (!query.client_id) throw new ChatGptError("client", "OpenAI did not finish registering AURA. Start the sign-in again.");
      clientId = query.client_id;
      this.saveRecord({ ...record, clientId });
    } else if (query.client_id && query.client_id !== clientId) {
      throw new ChatGptError("client", "OpenAI answered for another registration of AURA. Start the sign-in again.");
    }

    const tokens = await this.tokenRequest({
      grant_type: "authorization_code",
      client_id: clientId,
      code: query.code,
      code_verifier: pending.verifier,
      redirect_uri: pending.redirectUri,
      resource: OPENAI_API,
    });
    if (!tokens.id_token) throw new ChatGptError("token", "OpenAI did not return an identity for this sign-in.");
    const identity = await this.validateIdToken(tokens.id_token, clientId, pending.nonce);
    const session: ChatGptSession = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      idToken: tokens.id_token,
      expiresAt: this.now() + (tokens.expires_in ?? 3600) * 1000,
      scopes: (tokens.scope ?? query.scope ?? "").split(/\s+/).filter(Boolean),
      sub: identity.sub,
      email: identity.email,
    };
    this.saveRecord({ ...this.record(), clientId, session });
    return { firstTime, account: this.account()! };
  }

  /** A valid access token, refreshed when it is about to expire (or when `force` is set after a rejection). */
  async accessToken(force = false): Promise<string> {
    const s = this.secrets.read().chatgpt?.session;
    if (!s) throw new ChatGptError("signed_out", "AURA is not signed in to ChatGPT. Use Continue with ChatGPT in Settings > Assistant.");
    if (!force && s.expiresAt - this.now() > REFRESH_MARGIN_MS) return s.accessToken;
    if (!s.refreshToken) {
      if (s.expiresAt > this.now()) return s.accessToken;
      this.clearSession();
      throw new ChatGptError("signed_out", "Your ChatGPT sign-in has expired. Sign in again in Settings > Assistant.");
    }
    // One refresh at a time: the refresh token changes with every refresh.
    this.refreshing ??= this.refresh(s).finally(() => {
      this.refreshing = null;
    });
    return (await this.refreshing).accessToken;
  }

  /** Revoke the sign-in with OpenAI and forget the tokens. The install's registration is kept for the next sign-in. */
  async signOut(): Promise<{ revoked: boolean }> {
    const record = this.secrets.read().chatgpt;
    const s = record?.session;
    if (!record || !s) return { revoked: true };
    let revoked = !s.refreshToken;
    if (s.refreshToken && record.clientId) {
      try {
        const endpoint = (await this.discover()).revocation_endpoint;
        if (endpoint) {
          const res = await this.fetchFn(endpoint, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token: s.refreshToken, token_type_hint: "refresh_token", client_id: record.clientId }),
            signal: AbortSignal.timeout(15_000),
          });
          revoked = res.ok;
        }
      } catch {
        revoked = false;
      }
    }
    this.clearSession();
    return { revoked };
  }

  private async refresh(s: ChatGptSession): Promise<ChatGptSession> {
    const record = this.record();
    if (!record.clientId || !s.refreshToken) throw new ChatGptError("signed_out", "Sign in again with ChatGPT in Settings > Assistant.");
    let tokens: TokenResponse;
    try {
      tokens = await this.tokenRequest({ grant_type: "refresh_token", client_id: record.clientId, refresh_token: s.refreshToken, resource: OPENAI_API });
    } catch (err) {
      if (err instanceof ChatGptError && err.code === "signed_out") this.clearSession();
      throw err;
    }
    const next: ChatGptSession = {
      ...s,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? s.refreshToken,
      idToken: tokens.id_token ?? s.idToken,
      expiresAt: this.now() + (tokens.expires_in ?? 3600) * 1000,
      scopes: tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : s.scopes,
    };
    this.saveRecord({ ...this.record(), session: next });
    return next;
  }

  private async tokenRequest(form: Record<string, string>): Promise<TokenResponse> {
    let res: Response;
    try {
      res = await this.fetchFn(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams(form),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new ChatGptError("network", "OpenAI could not be reached. Check your connection.");
    }
    const body = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & { error?: string };
    if (!res.ok || !body.access_token) {
      const code = body.error ?? `http_${res.status}`;
      if (TERMINAL_ERRORS.has(code)) throw new ChatGptError("signed_out", "Your ChatGPT sign-in has expired. Sign in again in Settings > Assistant.");
      if (code === "invalid_client") throw new ChatGptError("client", "OpenAI no longer accepts AURA's registration. Sign out, then sign in again.");
      throw new ChatGptError("token", `OpenAI refused the sign-in (${code}).`);
    }
    return body as TokenResponse;
  }

  private async discover(): Promise<Discovery> {
    if (this.discovery) return this.discovery;
    const fallback: Discovery = { issuer: ISSUER, jwks_uri: `${ISSUER}/.well-known/jwks.json`, revocation_endpoint: null };
    try {
      const res = await this.fetchFn(DISCOVERY_URL, { signal: AbortSignal.timeout(15_000) });
      const d = (await res.json()) as Partial<Discovery>;
      this.discovery = {
        issuer: typeof d.issuer === "string" ? d.issuer : fallback.issuer,
        jwks_uri: typeof d.jwks_uri === "string" ? d.jwks_uri : fallback.jwks_uri,
        revocation_endpoint: typeof d.revocation_endpoint === "string" ? d.revocation_endpoint : null,
      };
      return this.discovery;
    } catch {
      return fallback;
    }
  }

  /** Check the identity token's signature against OpenAI's published keys, then its claims. */
  private async validateIdToken(idToken: string, clientId: string, nonce: string): Promise<{ sub: string; email: string | null }> {
    const invalid = () => new ChatGptError("token", "AURA could not verify the ChatGPT sign-in. Start again.");
    const [h, p, sig] = idToken.split(".");
    if (!h || !p || !sig) throw invalid();
    let header: Record<string, unknown>;
    let claims: Record<string, unknown>;
    try {
      header = decodePart(h);
      claims = decodePart(p);
    } catch {
      throw invalid();
    }
    const d = await this.discover();
    let keys: (JsonWebKey & { kid?: string })[] = [];
    try {
      const res = await this.fetchFn(d.jwks_uri, { signal: AbortSignal.timeout(15_000) });
      keys = ((await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] }).keys ?? [];
    } catch {
      throw new ChatGptError("network", "OpenAI could not be reached to verify the sign-in.");
    }
    const jwk = keys.find((k) => k.kid === header.kid) ?? (keys.length === 1 ? keys[0] : undefined);
    if (!jwk) throw invalid();
    const key = createPublicKey({ key: jwk, format: "jwk" });
    const data = Buffer.from(`${h}.${p}`);
    const signature = Buffer.from(sig, "base64url");
    const ok =
      header.alg === "RS256"
        ? verify("sha256", data, key, signature)
        : header.alg === "ES256"
          ? verify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, signature)
          : false;
    if (!ok) throw invalid();

    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const exp = typeof claims.exp === "number" ? claims.exp * 1000 : 0;
    if (claims.iss !== d.issuer || !aud.includes(clientId) || exp + CLOCK_SKEW_MS < this.now() || claims.nonce !== nonce || typeof claims.sub !== "string") {
      throw invalid();
    }
    return { sub: claims.sub, email: typeof claims.email === "string" ? claims.email : null };
  }

  /** This install's record, created with a fresh host id the first time. */
  private record(): ChatGptRecord {
    const existing = this.secrets.read().chatgpt;
    if (existing) return existing;
    const fresh: ChatGptRecord = { hostId: `urn:uuid:${randomUUID()}`, clientId: null, session: null };
    this.saveRecord(fresh);
    return fresh;
  }

  private saveRecord(record: ChatGptRecord) {
    this.secrets.update((s) => ({ ...s, chatgpt: record }));
  }

  private clearSession() {
    const record = this.secrets.read().chatgpt;
    if (record) this.saveRecord({ ...record, session: null });
  }
}
