import { ZodError } from "zod";
import { DomainError } from "./domain/context";
import { log } from "./logger";

const STATUS_BY_CODE: Record<DomainError["code"], number> = {
  not_found: 404,
  validation: 400,
  conflict: 409,
  invalid_state: 409,
  forbidden: 403,
};

export interface ErrorReply {
  status: number;
  body: { error: { code: string; message: string; details?: unknown } };
}

/** Turn any error thrown by a route into the JSON error the interface expects. */
export function errorReply(err: unknown): ErrorReply {
  if (err instanceof DomainError) {
    return { status: STATUS_BY_CODE[err.code], body: { error: { code: err.code, message: err.message, details: err.details ?? null } } };
  }
  if (err instanceof ZodError) {
    const message = err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    return { status: 400, body: { error: { code: "validation", message, details: err.issues } } };
  }
  const e = err as { statusCode?: number; message?: string };
  if (e.statusCode && e.statusCode < 500) {
    return { status: e.statusCode, body: { error: { code: "bad_request", message: e.message ?? "Bad request" } } };
  }
  log.error("unhandled error", { error: e.message ?? String(err) });
  return { status: 500, body: { error: { code: "internal", message: "Something went wrong on AURA's side. Your data was not changed." } } };
}
