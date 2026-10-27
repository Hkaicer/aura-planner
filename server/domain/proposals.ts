import type { Change } from "../../shared/schemas";
import type { Database } from "../db/database";
import { DbStore } from "../db/store";
import type { PlanResult } from "../scheduling/engine";
import { applyChanges, recordHistory, sanitizeDependencies, summarizeChange, type ChangeSummary } from "./changes";
import { DomainError, newId } from "./context";

export type ProposalStatus = "pending" | "applied" | "auto_applied" | "discarded" | "failed" | "undone";

export interface Proposal {
  id: string;
  messageId: string | null;
  source: "ai" | "engine";
  status: ProposalStatus;
  summary: string;
  reason: string;
  requiresApproval: boolean;
  changes: Change[];
  items: ChangeSummary[];
  preview: { plans: PlanResult[] } | null;
  historyId: string | null;
  error: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

function rowToProposal(r: Record<string, unknown>): Proposal {
  const changes = JSON.parse(String(r.changes)) as Change[];
  return {
    id: String(r.id),
    messageId: r.message_id ? String(r.message_id) : null,
    source: r.source as Proposal["source"],
    status: r.status as ProposalStatus,
    summary: String(r.summary),
    reason: String(r.reason ?? ""),
    requiresApproval: r.requires_approval === 1 || r.requires_approval === 1n,
    changes,
    items: changes.map(summarizeChange),
    preview: r.preview ? (JSON.parse(String(r.preview)) as Proposal["preview"]) : null,
    historyId: r.history_id ? String(r.history_id) : null,
    error: r.error ? String(r.error) : null,
    createdAt: String(r.created_at),
    resolvedAt: r.resolved_at ? String(r.resolved_at) : null,
  };
}

export function createProposal(
  db: Database,
  p: {
    messageId: string | null;
    source: Proposal["source"];
    summary: string;
    reason: string;
    requiresApproval: boolean;
    changes: Change[];
    preview: Proposal["preview"];
    createdAt: string;
  },
): Proposal {
  const id = newId("pr");
  db.run(
    `INSERT INTO proposals (id, message_id, source, status, summary, reason, requires_approval, changes, preview, created_at)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    id,
    p.messageId,
    p.source,
    p.summary,
    p.reason,
    p.requiresApproval ? 1 : 0,
    JSON.stringify(p.changes),
    p.preview ? JSON.stringify(p.preview) : null,
    p.createdAt,
  );
  return getProposal(db, id)!;
}

export function getProposal(db: Database, id: string): Proposal | null {
  const r = db.get("SELECT * FROM proposals WHERE id = ?", id);
  return r ? rowToProposal(r) : null;
}

export function listProposals(db: Database, ids: string[]): Proposal[] {
  if (ids.length === 0) return [];
  return db.all(`SELECT * FROM proposals WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids).map(rowToProposal);
}

export function pendingProposals(db: Database): Proposal[] {
  return db.all("SELECT * FROM proposals WHERE status = 'pending' ORDER BY created_at DESC").map(rowToProposal);
}

export function linkProposalMessage(db: Database, id: string, messageId: string) {
  db.run("UPDATE proposals SET message_id = ? WHERE id = ?", messageId, id);
}

/**
 * Apply a pending proposal (optionally without some of its items) atomically,
 * recording a history entry so the whole set can be undone.
 */
export function applyProposal(
  db: Database,
  id: string,
  opts: { exclude?: string[]; auto?: boolean; nowIso: string },
): Proposal {
  try {
    return applyProposalTx(db, id, opts);
  } catch (err) {
    if (err instanceof DomainError && err.code === "conflict") {
      db.run("UPDATE proposals SET status = 'failed', error = ?, resolved_at = ? WHERE id = ?", err.message, opts.nowIso, id);
    }
    throw err;
  }
}

function applyProposalTx(db: Database, id: string, opts: { exclude?: string[]; auto?: boolean; nowIso: string }): Proposal {
  return db.tx(() => {
    const proposal = getProposal(db, id);
    if (!proposal) throw new DomainError("not_found", "This proposal no longer exists.");
    if (proposal.status !== "pending") throw new DomainError("invalid_state", `This proposal was already ${proposal.status.replace("_", " ")}.`);
    const exclude = new Set(opts.exclude ?? []);
    const selected = proposal.changes.filter((c) => !exclude.has(`${c.entity}:${c.id}`));
    if (selected.length === 0) throw new DomainError("validation", "Select at least one change to apply.");
    const store = new DbStore(db);
    const performed: Change[] = applyChanges(store, selected, "forward", opts.nowIso);
    if (exclude.size > 0) sanitizeDependencies(store, performed, opts.nowIso);
    const history = recordHistory(db, {
      label: proposal.summary,
      source: proposal.source,
      changes: performed,
      createdAt: opts.nowIso,
    });
    db.run(
      "UPDATE proposals SET status = ?, history_id = ?, resolved_at = ? WHERE id = ?",
      opts.auto ? "auto_applied" : "applied",
      history.id,
      opts.nowIso,
      id,
    );
    return getProposal(db, id)!;
  });
}

export function discardProposal(db: Database, id: string, nowIso: string): Proposal {
  const proposal = getProposal(db, id);
  if (!proposal) throw new DomainError("not_found", "This proposal no longer exists.");
  if (proposal.status !== "pending") throw new DomainError("invalid_state", `This proposal was already ${proposal.status.replace("_", " ")}.`);
  db.run("UPDATE proposals SET status = 'discarded', resolved_at = ? WHERE id = ?", nowIso, id);
  return getProposal(db, id)!;
}
