// Secrets AURA keeps on this computer: an API key saved in Settings and the
// ChatGPT sign-in. They live in their own file next to the database, readable by
// the current user only, and never go into the database, backups, exports or logs.

import fs from "node:fs";
import path from "node:path";
import type { ApiService } from "../shared/api";

export interface SavedApiKey {
  service: ApiService;
  key: string;
}

/** A ChatGPT session: the tokens OpenAI issued after the user signed in. */
export interface ChatGptSession {
  accessToken: string;
  refreshToken: string | null;
  idToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  scopes: string[];
  sub: string;
  email: string | null;
}

export interface ChatGptRecord {
  /** Opaque identifier of this AURA install, chosen once and reused for every sign-in. */
  hostId: string;
  /** Issued by OpenAI at the first sign-in (oaiapp_…) and kept after signing out. */
  clientId: string | null;
  session: ChatGptSession | null;
}

export interface Secrets {
  apiKey?: SavedApiKey;
  chatgpt?: ChatGptRecord;
}

export class SecretStore {
  private memory: Secrets = {};

  /** `file` null keeps everything in memory (tests). */
  constructor(private readonly file: string | null) {}

  read(): Secrets {
    if (!this.file) return structuredClone(this.memory);
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Secrets) : {};
    } catch {
      return {};
    }
  }

  update(fn: (current: Secrets) => Secrets): Secrets {
    const next = fn(this.read());
    if (!this.file) {
      this.memory = structuredClone(next);
      return next;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      // Not supported on every file system.
    }
    return next;
  }
}
