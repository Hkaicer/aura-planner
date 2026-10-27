import { randomBytes } from "node:crypto";
import type { Settings } from "../../shared/schemas";
import { zonedNow, type ZonedNow } from "../../shared/time";
import type { Store } from "../db/store";

export type DomainErrorCode = "not_found" | "validation" | "conflict" | "invalid_state" | "forbidden";

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export interface DomainContext {
  store: Store;
  settings: Settings;
  /** Real instant used for timestamps. */
  clock: () => Date;
}

export function nowIso(ctx: DomainContext): string {
  return ctx.clock().toISOString();
}

export function localNow(ctx: DomainContext): ZonedNow {
  return zonedNow(ctx.settings.timeZone, ctx.clock());
}

export function today(ctx: DomainContext): string {
  return localNow(ctx).date;
}

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export function newId(prefix: string, length = 8): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return `${prefix}_${out}`;
}

/** Bump revision and modification time before writing an entity. */
export function touch<T extends { rev: number; updatedAt: string }>(ctx: DomainContext, value: T): T {
  return { ...value, rev: value.rev + 1, updatedAt: nowIso(ctx) };
}
