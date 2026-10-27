import { useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Check, CheckCircle2, Circle, Flag, Moon, Sparkles, Sunrise } from "lucide-react";
import { useMemo, useState } from "react";
import type { Proposal } from "@shared/api";
import { parseQuickAdd } from "@shared/quickadd";
import type { Task } from "@shared/schemas";
import { addDays, combine, formatDuration } from "@shared/time";
import { api } from "../lib/api";
import { relativeDay } from "../lib/format";
import { useLang, useT } from "../lib/i18n";
import { errorMessage, invalidatePlanning, useAction, useAiStatus, useBootstrap, useDay, useNow, useTasks } from "../lib/queries";
import { useUi } from "../lib/store";
import { toast } from "../lib/toast";
import { AuraMark } from "./Sidebar";
import { ProposalView } from "./ProposalView";
import { PriorityIcon } from "./task";
import { Badge, Button, Dialog, Field, Kbd, Spinner } from "./ui";

// ---------------------------------------------------------------------------
// First run
// ---------------------------------------------------------------------------

export function Onboarding() {
  const t = useT();
  const boot = useBootstrap();
  const ai = useAiStatus();
  const qc = useQueryClient();
  const settings = boot.data?.settings;
  const [name, setName] = useState("");
  const [language, setLanguage] = useState<"en" | "fr">(navigator.language.toLowerCase().startsWith("fr") ? "fr" : "en");
  const [dayStart, setDayStart] = useState(settings?.dayStart ?? "08:30");
  const [dayEnd, setDayEnd] = useState(settings?.dayEnd ?? "22:00");
  const [keepDemo, setKeepDemo] = useState(true);
  const [saving, setSaving] = useState(false);
  if (!settings || settings.onboarded) return null;
  const submit = async () => {
    setSaving(true);
    try {
      await api.onboarding({ displayName: name.trim(), language, dayStart, dayEnd, keepDemo });
      invalidatePlanning(qc);
      await qc.invalidateQueries({ queryKey: ["bootstrap"] });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open onClose={() => undefined} size="sm" labelledBy="onboarding-title">
      <div className="onboarding">
        <AuraMark size={40} />
        <h2 id="onboarding-title">{t("onboarding.title")}</h2>
        <p>{t("onboarding.body")}</p>
      </div>
      <div className="dialog-body">
        <Field label={t("onboarding.name")}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} data-autofocus maxLength={60} />
        </Field>
        <div className="field-row">
          <Field label={t("onboarding.language")}>
            <select className="select" value={language} onChange={(e) => setLanguage(e.target.value as "en" | "fr")}>
              <option value="en">English</option>
              <option value="fr">Français</option>
            </select>
          </Field>
          <Field label={t("onboarding.hours")}>
            <div className="row" style={{ gap: 6 }}>
              <input className="input" type="time" value={dayStart} onChange={(e) => setDayStart(e.target.value)} aria-label={t("task.start")} />
              <input className="input" type="time" value={dayEnd} onChange={(e) => setDayEnd(e.target.value)} aria-label={t("task.end")} />
            </div>
          </Field>
        </div>
        <div className="onboarding-ai">
          <span className={`status-dot is-${ai.data?.state === "ready" ? "ready" : "warn"}`} />
          <div>
            <div className="field-label">{t("onboarding.ai")}</div>
            <div className="field-hint">{ai.isLoading ? t("common.loading") : ai.data?.message}</div>
          </div>
        </div>
        <label className="checkbox-line">
          <input type="checkbox" checked={keepDemo} onChange={(e) => setKeepDemo(e.target.checked)} />
          <span>
            {t("onboarding.demo")}
            <span className="field-hint" style={{ display: "block" }}>
              {t("onboarding.demoHint")}
            </span>
          </span>
        </label>
      </div>
      <div className="dialog-footer">
        <Button variant="primary" size="lg" onClick={() => void submit()} loading={saving} disabled={dayEnd <= dayStart}>
          {t("onboarding.start")}
        </Button>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Morning planning: commitments → capture → unfinished → schedule
// ---------------------------------------------------------------------------

export function MorningPlanning({ onClose }: { onClose: () => void }) {
  const t = useT();
  const lang = useLang();
  const ui = useUi();
  const now = useNow();
  const day = useDay(now.date);
  const open = useTasks("open");
  const ai = useAiStatus();
  const run = useAction();
  const [step, setStep] = useState(0);
  const [capture, setCapture] = useState("");
  const [added, setAdded] = useState<number | null>(null);
  const [bring, setBring] = useState<Set<string>>(new Set());
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [busy, setBusy] = useState(false);

  const deadlines = useMemo(
    () =>
      (open.data ?? [])
        .filter((x) => x.dueAt && x.dueAt <= `${addDays(now.date, 3)}T23:59`)
        .sort((a, b) => a.dueAt!.localeCompare(b.dueAt!))
        .slice(0, 8),
    [open.data, now.date],
  );
  const unfinished = useMemo(
    () => (open.data ?? []).filter((x) => (x.plannedDate && x.plannedDate < now.date) || (!x.plannedDate && x.dueAt && x.dueAt <= `${addDays(now.date, 2)}T23:59`)),
    [open.data, now.date],
  );
  const steps = [t("morning.step1"), t("morning.step2"), t("morning.step3"), t("morning.step4")];

  const addLines = async () => {
    const lines = capture.split("\n").map((l) => l.trim()).filter(Boolean);
    let n = 0;
    for (const line of lines) {
      const p = parseQuickAdd(line, now.date);
      if (!p.title) continue;
      const date = p.plannedDate ?? now.date;
      const res = await run(
        () =>
          api.createTask({
            title: p.title,
            ...(p.priority ? { priority: p.priority } : {}),
            ...(p.estimateMin ? { estimateMin: p.estimateMin } : {}),
            ...(p.tags.length ? { tags: p.tags } : {}),
            ...(p.dueDate ? { dueAt: combine(p.dueDate, "23:59") } : {}),
            ...(p.start ? { scheduledStart: combine(date, p.start), pinned: true } : { plannedDate: date }),
          }),
        { silent: true },
      );
      if (res) n++;
    }
    setAdded(n);
    setCapture("");
  };

  const generate = async () => {
    setBusy(true);
    try {
      if (bring.size) await api.postpone([...bring], now.date);
      setProposal(await api.plan(now.date, "full"));
      setStep(3);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} size="lg" title={t("morning.title")} icon={<Sunrise className="dialog-icon" />} labelledBy="morning-title">
      <div className="stepper" role="list">
        {steps.map((s, i) => (
          <button key={s} type="button" role="listitem" className={`step ${i === step ? "is-active" : ""} ${i < step ? "is-done" : ""}`} onClick={() => i < 3 && setStep(i)} disabled={i === 3 && !proposal}>
            <span className="step-num">{i < step ? <Check /> : i + 1}</span>
            {s}
          </button>
        ))}
      </div>
      <div className="dialog-body flow-body">
        {step === 0 && (
          <>
            <section>
              <div className="section-title">{t("morning.commitments")}</div>
              {(day.data?.events ?? []).filter((e) => !e.allDay).length === 0 ? (
                <p className="faint">{t("morning.noEvents")}</p>
              ) : (
                <ul className="flow-list">
                  {day.data!.events
                    .filter((e) => !e.allDay)
                    .map((e) => (
                      <li key={e.id}>
                        <CalendarClock />
                        <span className="tnum faint">
                          {e.start}–{e.end}
                        </span>
                        <span className="truncate">{e.title}</span>
                      </li>
                    ))}
                </ul>
              )}
            </section>
            <section>
              <div className="section-title">{t("morning.deadlines")}</div>
              {deadlines.length === 0 ? (
                <p className="faint">{t("morning.noDeadlines")}</p>
              ) : (
                <ul className="flow-list">
                  {deadlines.map((x) => (
                    <li key={x.id}>
                      <Flag className={x.dueAt! < now.dateTime ? "tone-danger" : ""} />
                      <span className="faint">{relativeDay(x.dueAt!.slice(0, 10), now.date, lang, t)}</span>
                      <span className="truncate">{x.title}</span>
                      <PriorityIcon priority={x.priority} size={12} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
        {step === 1 && (
          <>
            <Field label={t("morning.capturePrompt")}>
              <textarea className="textarea" rows={6} value={capture} onChange={(e) => setCapture(e.target.value)} placeholder={t("morning.capturePlaceholder")} data-autofocus />
            </Field>
            <div className="row">
              <Button onClick={() => void addLines()} disabled={!capture.trim()}>
                {t("morning.addLines")}
              </Button>
              <Button
                variant="ghost"
                icon={<Sparkles />}
                disabled={!capture.trim() || ai.data?.state !== "ready"}
                onClick={() => {
                  ui.askAssistant(capture, true);
                  onClose();
                }}
              >
                {t("morning.askAura")}
              </Button>
              {added !== null && <span className="faint">{t("morning.added", { n: added })}</span>}
            </div>
          </>
        )}
        {step === 2 && (
          <section>
            <div className="section-title">{t("morning.unfinished")}</div>
            {unfinished.length === 0 ? (
              <p className="faint">{t("morning.noUnfinished")}</p>
            ) : (
              <ul className="flow-list flow-checklist">
                {unfinished.map((x) => (
                  <li key={x.id}>
                    <label className="checkbox-line">
                      <input
                        type="checkbox"
                        checked={bring.has(x.id)}
                        onChange={() => {
                          const n = new Set(bring);
                          if (n.has(x.id)) n.delete(x.id);
                          else n.add(x.id);
                          setBring(n);
                        }}
                      />
                      <span className="truncate">{x.title}</span>
                    </label>
                    <span className="faint tnum">{formatDuration(x.estimateMin)}</span>
                    {x.plannedDate && <Badge tone="warning">{relativeDay(x.plannedDate, now.date, lang, t)}</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        {step === 3 && proposal && (
          <ProposalView
            proposal={proposal}
            onResolved={(p) => {
              if (p?.status === "applied") toast.success(t("morning.done"));
              onClose();
            }}
          />
        )}
      </div>
      {step < 3 && (
        <div className="dialog-footer">
          {step > 0 && (
            <Button variant="ghost" onClick={() => setStep(step - 1)}>
              {t("common.back")}
            </Button>
          )}
          <span className="spacer" />
          {step < 2 ? (
            <Button variant="primary" onClick={() => setStep(step + 1)}>
              {t("common.next")}
            </Button>
          ) : (
            <Button variant="primary" icon={busy ? <Spinner /> : undefined} onClick={() => void generate()} disabled={busy}>
              {t("morning.generate")}
            </Button>
          )}
        </div>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Evening review
// ---------------------------------------------------------------------------

type Carry = "tomorrow" | "backlog" | "keep";

export function EveningReview({ onClose }: { onClose: () => void }) {
  const t = useT();
  const now = useNow();
  const day = useDay(now.date);
  const run = useAction();
  const qc = useQueryClient();
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [carry, setCarry] = useState<Record<string, Carry>>({});
  const [note, setNote] = useState(day.data?.plan.review?.note ?? "");
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [saving, setSaving] = useState(false);
  const tasks = day.data?.tasks ?? [];
  const done = tasks.filter((x) => x.status === "done");
  const incomplete = tasks.filter((x) => x.status !== "done" && x.status !== "cancelled");
  const est = done.reduce((s, x) => s + x.estimateMin, 0);
  const act = done.reduce((s, x) => s + (x.actualMin ?? x.estimateMin), 0);
  const tomorrow = addDays(now.date, 1);
  const reasonOptions = [t("evening.reasons.time"), t("evening.reasons.blocked"), t("evening.reasons.priority"), t("evening.reasons.energy")];

  const save = async (planTomorrow: boolean) => {
    setSaving(true);
    const carryOver = incomplete.filter((x) => (carry[x.id] ?? "tomorrow") === "tomorrow").map((x) => ({ taskId: x.id, toDate: tomorrow }));
    const res = await run(() => api.review(now.date, { note, reasons, carryOver }), { success: t("evening.saved"), undoLabel: t("common.undo") });
    for (const x of incomplete.filter((y) => carry[y.id] === "backlog")) await api.unscheduleTask(x.id, true).catch(() => undefined);
    invalidatePlanning(qc);
    if (res && planTomorrow) {
      try {
        setProposal(await api.plan(tomorrow, "full"));
      } catch (err) {
        toast.error(errorMessage(err));
      }
    } else if (res) onClose();
    setSaving(false);
  };

  return (
    <Dialog open onClose={onClose} size="lg" title={t("evening.title")} icon={<Moon className="dialog-icon" />} labelledBy="evening-title">
      <div className="dialog-body flow-body">
        {proposal ? (
          <ProposalView proposal={proposal} onResolved={() => onClose()} />
        ) : tasks.length === 0 ? (
          <p className="faint">{t("evening.nothing")}</p>
        ) : (
          <>
            <div className="review-stats">
              <div>
                <span className="eyebrow">{t("evening.progress")}</span>
                <strong className="tnum">
                  {done.length}/{tasks.length}
                </strong>
              </div>
              <div>
                <span className="eyebrow">{t("task.estimate")}</span>
                <strong className="tnum">{t("evening.estimates", { est: formatDuration(est), act: formatDuration(act) })}</strong>
              </div>
            </div>
            {done.length > 0 && (
              <section>
                <div className="section-title">{t("evening.completed")}</div>
                <ul className="flow-list">
                  {done.map((x) => (
                    <li key={x.id}>
                      <CheckCircle2 className="tone-success" />
                      <span className="truncate">{x.title}</span>
                      <span className="faint tnum">
                        {formatDuration(x.estimateMin)}
                        {x.actualMin ? ` → ${formatDuration(x.actualMin)}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {incomplete.length > 0 && (
              <section>
                <div className="section-title">{t("evening.incomplete")}</div>
                <ul className="flow-list review-incomplete">
                  {incomplete.map((x: Task) => (
                    <li key={x.id}>
                      <Circle className="faint" />
                      <div className="review-task">
                        <span className="truncate">{x.title}</span>
                        <div className="row" style={{ flexWrap: "wrap", gap: 4 }}>
                          {reasonOptions.map((r) => (
                            <button key={r} type="button" className={`chip ${reasons[x.id] === r ? "chip-active" : ""}`} onClick={() => setReasons({ ...reasons, [x.id]: reasons[x.id] === r ? "" : r })}>
                              {r}
                            </button>
                          ))}
                        </div>
                      </div>
                      <select className="select select-sm" style={{ width: 130 }} value={carry[x.id] ?? "tomorrow"} onChange={(e) => setCarry({ ...carry, [x.id]: e.target.value as Carry })} aria-label={t("evening.carryTo")}>
                        <option value="tomorrow">{t("common.tomorrow")}</option>
                        <option value="backlog">{t("evening.backlog")}</option>
                        <option value="keep">{t("evening.keep")}</option>
                      </select>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <Field label={t("evening.note")}>
              <textarea className="textarea" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </>
        )}
      </div>
      {!proposal && tasks.length > 0 && (
        <div className="dialog-footer">
          <Button variant="ghost" onClick={() => void save(false)} disabled={saving}>
            {t("evening.save")}
          </Button>
          <Button variant="primary" onClick={() => void save(true)} loading={saving}>
            {t("evening.saveAndPlan")}
          </Button>
        </div>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Shortcuts
// ---------------------------------------------------------------------------

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const rows: [string, string][] = [
    ["Ctrl K", t("shortcuts.palette")],
    ["N", t("shortcuts.newTask")],
    ["J", t("shortcuts.assistant")],
    ["/", t("shortcuts.focusAssistant")],
    ["F", t("shortcuts.focus")],
    ["Ctrl Z", t("shortcuts.undo")],
    ["1 2 3", t("shortcuts.views")],
    ["G T", t("shortcuts.goToday")],
    ["G U", t("shortcuts.goUpcoming")],
    ["G I", t("shortcuts.goInbox")],
    ["G A", t("shortcuts.goAll")],
    ["G P", t("shortcuts.goProjects")],
    ["G C", t("shortcuts.goCalendar")],
    ["G D", t("shortcuts.goCompleted")],
    ["G S", t("shortcuts.goSettings")],
    ["?", t("shortcuts.help")],
    ["Esc", t("shortcuts.close")],
  ];
  return (
    <Dialog open onClose={onClose} size="sm" title={t("shortcuts.title")} labelledBy="shortcuts-title">
      <div className="dialog-body">
        <ShortcutTable rows={rows} />
        <p className="field-hint">{t("shortcuts.globalNote")}</p>
      </div>
    </Dialog>
  );
}

export function ShortcutTable({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="shortcut-table">
      {rows.map(([k, label]) => (
        <div key={k} className="shortcut-row">
          <dt>{label}</dt>
          <dd>
            {k.split(" ").map((part, i) => (
              <Kbd key={i}>{part}</Kbd>
            ))}
          </dd>
        </div>
      ))}
    </dl>
  );
}
