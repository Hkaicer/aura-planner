import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CalendarClock, Check, ChevronDown, CircleSlash, Coffee, Plus, RotateCcw, Sparkles, Trash2, Utensils, Wand2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { ChangeSummary, PlanResult, Proposal } from "@shared/api";
import { formatDuration, fromMinutes } from "@shared/time";
import { api } from "../lib/api";
import { relativeDay } from "../lib/format";
import { useLang, useT, type Key } from "../lib/i18n";
import { errorMessage, invalidatePlanning, useNow } from "../lib/queries";
import { toast } from "../lib/toast";
import { Badge, Button, IconButton, Spinner } from "./ui";

const STATUS_TONE: Record<Proposal["status"], "accent" | "success" | "neutral" | "danger" | "warning"> = {
  pending: "accent",
  applied: "success",
  auto_applied: "success",
  discarded: "neutral",
  failed: "danger",
  undone: "neutral",
};

function KindIcon({ kind }: { kind: ChangeSummary["kind"] }) {
  if (kind === "created") return <Plus />;
  if (kind === "deleted") return <Trash2 />;
  if (kind === "completed") return <Check />;
  if (kind === "unscheduled") return <CircleSlash />;
  if (kind === "scheduled" || kind === "moved") return <CalendarClock />;
  return <Wand2 />;
}

export function PlanPreview({ plan }: { plan: PlanResult }) {
  const t = useT();
  const lang = useLang();
  const now = useNow();
  const rows = [
    ...plan.placements.map((p) => ({ type: "task" as const, start: p.start, end: p.end, title: p.title, moved: p.moved, prev: p.previousStart })),
    ...plan.breaks.map((b) => ({ type: "break" as const, start: b.start, end: b.end, title: t("today.break"), moved: false, prev: null })),
    ...(plan.lunch ? [{ type: "lunch" as const, start: plan.lunch.start, end: plan.lunch.end, title: t("today.lunch"), moved: false, prev: null }] : []),
  ].sort((a, b) => a.start - b.start);
  const status = plan.stats.status;
  return (
    <div className="plan-preview">
      <div className="plan-head">
        <span className="plan-day">{relativeDay(plan.date, now.date, lang, t)}</span>
        <Badge tone={status === "overloaded" ? "danger" : status === "tight" ? "warning" : status === "ok" ? "success" : "neutral"} dot>
          {t(`day.status.${status}` as Key)}
        </Badge>
        <span className="spacer" />
        <span className="faint tnum">
          {formatDuration(plan.stats.scheduledMin)} · {t("proposal.free", { time: formatDuration(plan.stats.freeMin) })}
        </span>
      </div>
      {rows.length > 0 && (
        <ol className="plan-rows">
          {rows.map((r, i) => (
            <li key={i} className={`plan-row plan-row-${r.type}`}>
              <span className="plan-time tnum">
                {fromMinutes(r.start)}
                <span className="faint">–{fromMinutes(r.end)}</span>
              </span>
              <span className="plan-title truncate">
                {r.type === "lunch" && <Utensils />}
                {r.type === "break" && <Coffee />}
                {r.title}
              </span>
              {r.type === "task" && r.moved && r.prev !== null && <span className="plan-moved tnum">{fromMinutes(r.prev)} →</span>}
            </li>
          ))}
        </ol>
      )}
      {plan.overflow.length > 0 && (
        <div className="plan-overflow">
          <div className="plan-overflow-title">
            <AlertTriangle />
            {t("proposal.doesNotFit")}
          </div>
          {plan.overflow.map((o) => (
            <div key={o.taskId} className="plan-overflow-row">
              <span className="truncate">{o.title}</span>
              <span className="faint">
                {t(`proposal.reason.${o.reason}` as Key)} · {formatDuration(o.estimateMin)}
                {o.suggestedDate ? ` · ${t("proposal.suggested", { when: relativeDay(o.suggestedDate, now.date, lang, t).toLowerCase() })}` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
      {plan.warnings.length > 0 && (
        <ul className="plan-warnings">
          {plan.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ProposalView({ proposal, onResolved, compact }: { proposal: Proposal; onResolved?: (p: Proposal | null) => void; compact?: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<"apply" | "discard" | "undo" | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const pending = proposal.status === "pending";
  const items = useMemo(() => proposal.items.filter((i) => i.entity !== "dayPlan" || i.details.length > 0), [proposal.items]);
  const visible = showAll ? items : items.slice(0, compact ? 6 : 10);
  const selected = items.length - excluded.size;
  const plans = proposal.preview?.plans ?? [];

  const refresh = () => {
    invalidatePlanning(qc);
    void qc.invalidateQueries({ queryKey: ["conversation"] });
  };

  const apply = async () => {
    setBusy("apply");
    try {
      const p = await api.applyProposal(proposal.id, [...excluded]);
      refresh();
      toast.show({
        message: t("toast.applied"),
        ...(p.historyId
          ? {
              action: {
                label: t("common.undo"),
                run: async () => {
                  await api.undo(p.historyId!);
                  refresh();
                },
              },
            }
          : {}),
      });
      onResolved?.(p);
    } catch (err) {
      toast.error(errorMessage(err));
      refresh();
    } finally {
      setBusy(null);
    }
  };

  const discard = async () => {
    setBusy("discard");
    try {
      const p = await api.discardProposal(proposal.id);
      refresh();
      onResolved?.(p);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const undo = async () => {
    if (!proposal.historyId) return;
    setBusy("undo");
    try {
      const r = await api.undo(proposal.historyId);
      toast.show({ message: t("toast.undone", { label: r.label }) });
      refresh();
      onResolved?.(null);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  if (items.length === 0 && plans.every((p) => p.placements.length === 0 && p.overflow.length === 0)) {
    return <div className="proposal proposal-empty">{t("proposal.noChanges")}</div>;
  }

  // Resolved proposals collapse to one line in the conversation so the live plan stays the focus.
  if (compact && !pending && !expanded) {
    return (
      <div className={`proposal proposal-collapsed is-${proposal.status}`}>
        <span className="proposal-icon">{proposal.status === "applied" || proposal.status === "auto_applied" ? <Check /> : proposal.source === "engine" ? <CalendarClock /> : <Sparkles />}</span>
        <div className="proposal-heading">
          <span className="proposal-summary-strong truncate">{proposal.summary}</span>
        </div>
        <Badge tone={STATUS_TONE[proposal.status]}>{t(`proposal.${proposal.status}` as Key)}</Badge>
        <button type="button" className="proposal-toggle" onClick={() => setExpanded(true)}>
          {t("proposal.showChanges")}
        </button>
        {(proposal.status === "applied" || proposal.status === "auto_applied") && proposal.historyId && (
          <IconButton size="sm" label={t("common.undo")} onClick={() => void undo()} disabled={busy !== null}>
            {busy === "undo" ? <Spinner /> : <RotateCcw />}
          </IconButton>
        )}
      </div>
    );
  }

  return (
    <div className={`proposal is-${proposal.status}`}>
      <div className="proposal-head">
        <span className="proposal-icon">{proposal.source === "engine" ? <CalendarClock /> : <Sparkles />}</span>
        <div className="proposal-heading">
          <span className="proposal-title">{proposal.source === "engine" ? t("proposal.engineTitle") : t("proposal.title")}</span>
          <span className="proposal-summary">{proposal.summary}</span>
        </div>
        <Badge tone={STATUS_TONE[proposal.status]}>{t(`proposal.${proposal.status}` as Key)}</Badge>
        {compact && !pending && (
          <button type="button" className="proposal-toggle" onClick={() => setExpanded(false)}>
            {t("proposal.hideChanges")}
          </button>
        )}
      </div>

      {plans.map((plan) => (
        <PlanPreview key={plan.date} plan={plan} />
      ))}

      {items.length > 0 && (
        <ul className="proposal-items">
          {visible.map((i) => {
            const off = excluded.has(i.key);
            return (
              <li key={i.key} className={`proposal-item ${off ? "is-off" : ""} kind-${i.kind}`}>
                {pending ? (
                  <input
                    type="checkbox"
                    checked={!off}
                    aria-label={i.title}
                    onChange={() => {
                      const next = new Set(excluded);
                      if (off) next.delete(i.key);
                      else next.add(i.key);
                      setExcluded(next);
                    }}
                  />
                ) : (
                  <span className="proposal-kind-icon">
                    <KindIcon kind={i.kind} />
                  </span>
                )}
                <div className="proposal-item-main">
                  <div className="proposal-item-title">
                    <span className={`proposal-kind kind-${i.kind}`}>{t(`proposal.kind.${i.kind}` as Key)}</span>
                    <span className="truncate">{i.entity === "dayPlan" ? t("proposal.dayPlan") : i.title}</span>
                  </div>
                  {i.details.length > 0 && <div className="proposal-item-details">{i.details.join(" · ")}</div>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {items.length > visible.length && (
        <button type="button" className="proposal-more" onClick={() => setShowAll(true)}>
          <ChevronDown />
          {t("proposal.more", { n: items.length - visible.length })}
        </button>
      )}

      {proposal.status === "failed" && proposal.error && <div className="proposal-error">{proposal.error}</div>}
      {pending && proposal.reason && proposal.source === "ai" && (
        <div className="proposal-reason">{t("proposal.heldBecause", { reason: proposal.reason.replace(/\.$/, "").toLowerCase() })}</div>
      )}

      {pending && (
        <div className="proposal-actions">
          <Button variant="ghost" size="sm" onClick={() => void discard()} loading={busy === "discard"} disabled={busy !== null}>
            {t("common.discard")}
          </Button>
          <Button variant="primary" size="sm" icon={<Check />} onClick={() => void apply()} loading={busy === "apply"} disabled={busy !== null || selected === 0}>
            {excluded.size > 0 ? t("proposal.applySelected", { n: selected }) : t("proposal.apply")}
          </Button>
        </div>
      )}
      {(proposal.status === "applied" || proposal.status === "auto_applied") && proposal.historyId && (
        <div className="proposal-actions">
          <Button variant="ghost" size="sm" icon={<RotateCcw />} onClick={() => void undo()} loading={busy === "undo"}>
            {t("common.undo")}
          </Button>
        </div>
      )}
    </div>
  );
}
