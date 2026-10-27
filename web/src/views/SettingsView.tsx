import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  Bot,
  CalendarClock,
  Check,
  CircleAlert,
  Database,
  Download,
  Eye,
  Keyboard,
  KeyRound,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AiStatus, ApiService, CalendarFeed, CalendarSyncResult } from "@shared/api";
import { detectService } from "@shared/apiKeys";
import type { Settings, SettingsPatch } from "@shared/schemas";
import { ShortcutTable } from "../components/Flows";
import { Badge, Button, confirmAction, Dialog, Spinner, Switch } from "../components/ui";
import { ViewHeader } from "../components/ViewHeader";
import { api } from "../lib/api";
import { modelLabel, relativeTime } from "../lib/format";
import { useLang, useT, type Key } from "../lib/i18n";
import { assistantName, MANAGE_USAGE_URL, offersHaiku, usesChatGpt, usesDeepSeek } from "../lib/platform";
import { errorMessage, invalidatePlanning, useAction, useAiStatus, useBootstrap } from "../lib/queries";
import { useUi } from "../lib/store";
import { toast } from "../lib/toast";

const SECTIONS: { id: string; label: Key; icon: ReactNode }[] = [
  { id: "general", label: "settings.general", icon: <SlidersHorizontal /> },
  { id: "schedule", label: "settings.schedule", icon: <CalendarClock /> },
  { id: "assistant", label: "settings.assistant", icon: <Bot /> },
  { id: "notifications", label: "settings.notifications", icon: <Bell /> },
  { id: "data", label: "settings.data", icon: <Database /> },
  { id: "shortcuts", label: "settings.shortcuts", icon: <Keyboard /> },
];

function useSave() {
  const qc = useQueryClient();
  return async (patch: SettingsPatch) => {
    try {
      const s = await api.patchSettings(patch);
      qc.setQueryData(["bootstrap"], (b: unknown) => (b && typeof b === "object" ? { ...(b as object), settings: s } : b));
      invalidatePlanning(qc);
      void qc.invalidateQueries({ queryKey: ["ai-status"] });
      return s;
    } catch (err) {
      toast.error(errorMessage(err));
      return null;
    }
  };
}

export function SettingsView() {
  const t = useT();
  const ui = useUi();
  const boot = useBootstrap();
  const s = boot.data?.settings;
  const section = SECTIONS.some((x) => x.id === ui.settingsSection) ? ui.settingsSection : "general";
  return (
    <>
      <ViewHeader title={t("settings.title")} />
      <div className="view-body">
        <div className="settings">
          <nav className="settings-nav" aria-label={t("settings.title")}>
            {SECTIONS.map((x) => (
              <button key={x.id} type="button" className={`sb-item ${section === x.id ? "is-active" : ""}`} onClick={() => ui.setView("settings", { settingsSection: x.id })}>
                {x.icon}
                {t(x.label)}
              </button>
            ))}
          </nav>
          <div className="settings-content">
            {!s && <Spinner />}
            {s && section === "general" && <General s={s} systemTz={boot.data!.systemTimeZone} />}
            {s && section === "schedule" && <Schedule s={s} />}
            {s && section === "assistant" && <Assistant s={s} />}
            {s && section === "notifications" && <Notifications s={s} />}
            {s && section === "data" && <DataSection dataDir={boot.data!.dataDir} hasDemo={boot.data!.hasDemoData} />}
            {s && section === "shortcuts" && <Shortcuts />}
            <p className="settings-version faint">{t("settings.version", { v: boot.data?.version ?? "" })}</p>
          </div>
        </div>
      </div>
    </>
  );
}

function Card({ title, children, hint }: { title: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <section className="settings-card">
      <h2 className="settings-card-title">{title}</h2>
      {hint && <p className="settings-card-hint">{hint}</p>}
      <div className="settings-card-body">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-row-label">
        <span>{label}</span>
        {hint && <span className="field-hint">{hint}</span>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

function TextSetting({ value, onSave, placeholder, width = 220 }: { value: string; onSave: (v: string) => void; placeholder?: string; width?: number }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return <input className="input" style={{ width }} value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onSave(v)} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />;
}

function TimeRange({ start, end, onSave }: { start: string; end: string; onSave: (s: string, e: string) => void }) {
  const [a, setA] = useState(start);
  const [b, setB] = useState(end);
  useEffect(() => {
    setA(start);
    setB(end);
  }, [start, end]);
  const commit = () => (a !== start || b !== end) && onSave(a, b);
  return (
    <div className="row" style={{ gap: 6 }}>
      <input className="input" type="time" value={a} onChange={(e) => setA(e.target.value)} onBlur={commit} style={{ width: 110 }} />
      <span className="faint">–</span>
      <input className="input" type="time" value={b} onChange={(e) => setB(e.target.value)} onBlur={commit} style={{ width: 110 }} aria-invalid={b <= a} />
    </div>
  );
}

const minuteOptions = (values: number[]) => values.map((v) => <option key={v} value={v}>{v} min</option>);

// ---------------------------------------------------------------------------

function General({ s, systemTz }: { s: Settings; systemTz: string }) {
  const t = useT();
  const save = useSave();
  const zones = (() => {
    try {
      return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf("timeZone");
    } catch {
      return [s.timeZone];
    }
  })();
  return (
    <>
      <Card title={t("settings.general")}>
        <Row label={t("settings.name")}>
          <TextSetting value={s.displayName} onSave={(v) => void save({ displayName: v.trim() })} />
        </Row>
        <Row label={t("settings.language")}>
          <select className="select" style={{ width: 220 }} value={s.language} onChange={(e) => void save({ language: e.target.value as Settings["language"] })}>
            <option value="en">English</option>
            <option value="fr">Français</option>
          </select>
        </Row>
        <Row label={t("settings.theme")}>
          <div className="seg">
            {(["system", "light", "dark"] as const).map((th) => (
              <button key={th} type="button" aria-pressed={s.theme === th} onClick={() => void save({ theme: th })}>
                {t(`settings.theme.${th}`)}
              </button>
            ))}
          </div>
        </Row>
        <Row label={t("settings.timeZone")} hint={t("settings.timeZoneHint", { tz: systemTz })}>
          <select className="select" style={{ width: 220 }} value={s.timeZone} onChange={(e) => void save({ timeZone: e.target.value })}>
            {[...new Set([systemTz, s.timeZone, ...zones])].map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </Row>
      </Card>
    </>
  );
}

function Schedule({ s }: { s: Settings }) {
  const t = useT();
  const save = useSave();
  const days = t("weekday.short").split(",");
  return (
    <>
      <Card title={t("settings.schedule")}>
        <Row label={t("settings.workDays")}>
          <div className="weekday-picker">
            {days.map((d, i) => (
              <button
                key={d}
                type="button"
                aria-pressed={s.workDays.includes(i + 1)}
                onClick={() => void save({ workDays: s.workDays.includes(i + 1) ? s.workDays.filter((x) => x !== i + 1) : [...s.workDays, i + 1].sort() })}
              >
                {d}
              </button>
            ))}
          </div>
        </Row>
        <Row label={t("settings.dayHours")}>
          <TimeRange start={s.dayStart} end={s.dayEnd} onSave={(a, b) => void save({ dayStart: a, dayEnd: b })} />
        </Row>
        <Row label={t("settings.weekend")}>
          <Switch checked={s.weekendPlanning} onChange={(v) => void save({ weekendPlanning: v })} label={t("settings.weekend")} />
        </Row>
        {s.weekendPlanning && (
          <Row label={t("settings.weekendHours")}>
            <TimeRange start={s.weekendStart} end={s.weekendEnd} onSave={(a, b) => void save({ weekendStart: a, weekendEnd: b })} />
          </Row>
        )}
        <Row label={t("settings.sleep")} hint={t("settings.sleepHint")}>
          <TimeRange start={s.sleepStart} end={s.sleepEnd} onSave={(a, b) => void save({ sleepStart: a, sleepEnd: b })} />
        </Row>
      </Card>
      <Card title={t("settings.strategy")} hint={t("settings.strategyHint")}>
        <Row label={t("settings.strategy")}>
          <select className="select" style={{ width: 220 }} value={s.strategy} onChange={(e) => void save({ strategy: e.target.value as Settings["strategy"] })}>
            {(["balanced", "deadline_first", "priority_first"] as const).map((x) => (
              <option key={x} value={x}>
                {t(`settings.strategy.${x}`)}
              </option>
            ))}
          </select>
        </Row>
        <Row label={t("settings.peak")}>
          <select className="select" style={{ width: 220 }} value={s.peakEnergy} onChange={(e) => void save({ peakEnergy: e.target.value as Settings["peakEnergy"] })}>
            {(["morning", "afternoon", "evening"] as const).map((x) => (
              <option key={x} value={x}>
                {t(`settings.peak.${x}`)}
              </option>
            ))}
          </select>
        </Row>
        <Row label={t("settings.defaultEstimate")}>
          <select className="select" style={{ width: 120 }} value={s.defaultEstimateMin} onChange={(e) => void save({ defaultEstimateMin: Number(e.target.value) })}>
            {minuteOptions([15, 20, 25, 30, 45, 60, 90])}
          </select>
        </Row>
        <Row label={t("settings.focusBlock")}>
          <select className="select" style={{ width: 120 }} value={s.focusBlockMin} onChange={(e) => void save({ focusBlockMin: Number(e.target.value) })}>
            {minuteOptions([45, 60, 75, 90, 120, 150, 180])}
          </select>
        </Row>
        <Row label={t("settings.breakLength")}>
          <select className="select" style={{ width: 120 }} value={s.breakMin} onChange={(e) => void save({ breakMin: Number(e.target.value) })}>
            {minuteOptions([0, 5, 10, 15, 20, 30])}
          </select>
        </Row>
        <Row label={t("settings.buffer")}>
          <select className="select" style={{ width: 120 }} value={s.bufferMin} onChange={(e) => void save({ bufferMin: Number(e.target.value) })}>
            {minuteOptions([0, 5, 10, 15])}
          </select>
        </Row>
      </Card>
      <Card title={t("settings.lunch")}>
        <Row label={t("settings.lunch")}>
          <Switch checked={s.lunch.enabled} onChange={(v) => void save({ lunch: { enabled: v } })} label={t("settings.lunch")} />
        </Row>
        {s.lunch.enabled && (
          <>
            <Row label={t("settings.lunchWindow")}>
              <TimeRange start={s.lunch.earliest} end={s.lunch.latest} onSave={(a, b) => void save({ lunch: { earliest: a, latest: b } })} />
            </Row>
            <Row label={t("settings.lunchLength")}>
              <select className="select" style={{ width: 120 }} value={s.lunch.durationMin} onChange={(e) => void save({ lunch: { durationMin: Number(e.target.value) } })}>
                {minuteOptions([20, 30, 45, 60, 75, 90])}
              </select>
            </Row>
          </>
        )}
      </Card>
      <Unavailable s={s} />
    </>
  );
}

function Unavailable({ s }: { s: Settings }) {
  const t = useT();
  const save = useSave();
  const days = t("weekday.short").split(",");
  const update = (list: Settings["unavailable"]) => void save({ unavailable: list });
  return (
    <Card title={t("settings.unavailable")} hint={t("settings.unavailableHint")}>
      {s.unavailable.map((u, idx) => (
        <div key={u.id} className="unavailable-row">
          <TextSetting value={u.label} width={150} onSave={(v) => update(s.unavailable.map((x, i) => (i === idx ? { ...x, label: v } : x)))} />
          <div className="weekday-picker weekday-picker-sm">
            {days.map((d, i) => (
              <button
                key={d}
                type="button"
                aria-pressed={u.weekdays.includes(i + 1)}
                onClick={() => {
                  const wd = u.weekdays.includes(i + 1) ? u.weekdays.filter((x) => x !== i + 1) : [...u.weekdays, i + 1];
                  if (wd.length) update(s.unavailable.map((x, j) => (j === idx ? { ...x, weekdays: wd.sort() } : x)));
                }}
              >
                {d.slice(0, 2)}
              </button>
            ))}
          </div>
          <TimeRange start={u.start} end={u.end} onSave={(a, b) => update(s.unavailable.map((x, i) => (i === idx ? { ...x, start: a, end: b } : x)))} />
          <button type="button" className="icon-btn icon-btn-sm" aria-label={t("common.delete")} onClick={() => update(s.unavailable.filter((_, i) => i !== idx))}>
            <X />
          </button>
        </div>
      ))}
      <Button size="sm" icon={<Plus />} onClick={() => update([...s.unavailable, { id: `u_${Date.now().toString(36)}`, label: "", weekdays: [1, 2, 3, 4, 5], start: "12:00", end: "13:00" }])}>
        {t("settings.addUnavailable")}
      </Button>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function Assistant({ s }: { s: Settings }) {
  const t = useT();
  const lang = useLang();
  const save = useSave();
  const qc = useQueryClient();
  const status = useAiStatus();
  const [checking, setChecking] = useState(false);
  const [selfTest, setSelfTest] = useState<Awaited<ReturnType<typeof api.selfTest>> | null>(null);
  const [testing, setTesting] = useState(false);
  const st = status.data;

  const check = async () => {
    setChecking(true);
    try {
      await qc.fetchQuery({ queryKey: ["ai-status"], queryFn: () => api.aiStatus(true) });
    } finally {
      setChecking(false);
    }
  };

  const chooseProvider = async (p: Settings["ai"]["provider"]) => {
    if (p === "chatgpt") {
      const { ok } = await confirmAction({ title: t("chatgpt.consentDialog"), body: t("chatgpt.consentBody"), confirmLabel: t("chatgpt.continue"), cancelLabel: t("common.cancel") });
      if (!ok) return;
      // Signing in is how ChatGPT is chosen; once signed in, choosing it again only switches.
      if (st?.chatgpt?.planUsage) await save({ ai: { provider: "chatgpt" } });
      else await signInWithChatGpt();
      return;
    }
    if (p === "anthropic_api") {
      const deepseek = st?.apiService === "deepseek";
      const { ok } = await confirmAction({
        title: deepseek ? t("apikey.deepseekConsentDialog") : t("settings.apiConsentDialog"),
        body: deepseek ? t("apikey.deepseekConsentBody") : t("settings.apiConsentDialogBody"),
        confirmLabel: deepseek ? t("apikey.deepseekConsentGive") : t("settings.apiConsentGive"),
        cancelLabel: t("common.cancel"),
      });
      if (!ok) return;
      try {
        await api.apiConsent(true);
        void qc.invalidateQueries({ queryKey: ["bootstrap"] });
        void qc.invalidateQueries({ queryKey: ["ai-status"] });
      } catch (err) {
        toast.error(errorMessage(err));
      }
      return;
    }
    await save({ ai: { provider: p } });
  };

  const stateTone = st?.state === "ready" ? "success" : st?.state === "disabled" ? "neutral" : "warning";

  const providerChoices = ["claude_code", "chatgpt", "anthropic_api", "off"] as const;
  // The key's service names the API option even while another provider is in use.
  const keyIsDeepSeek = st?.apiService === "deepseek";
  const deepseek = usesDeepSeek(st);
  const chatgpt = usesChatGpt(st);
  const apiBilling = keyIsDeepSeek ? t("apikey.billing.deepseek") : t("ai.billing.api");
  const optionHint = (p: (typeof providerChoices)[number]) => {
    if (p === "claude_code") return t("ai.billing.subscription");
    if (p === "chatgpt") return st?.chatgpt ? (st.chatgpt.email ? t("chatgpt.signedIn", { email: st.chatgpt.email }) : t("chatgpt.signedInNoEmail")) : t("chatgpt.notSignedIn");
    if (p === "anthropic_api") return st?.apiKeyConfigured ? apiBilling : t("settings.apiKeyMissing");
    return t("ai.billing.none");
  };

  return (
    <>
      <ChatGptWelcome />
      <Card title={t("settings.provider")} hint={t("settings.providerHint")}>
        <div className="provider-options" role="radiogroup" aria-label={t("settings.provider")}>
          {providerChoices.map((p) => (
            <button key={p} type="button" role="radio" aria-checked={s.ai.provider === p} className={`provider-option ${s.ai.provider === p ? "is-selected" : ""}`} onClick={() => void chooseProvider(p)} disabled={p === "anthropic_api" && st !== undefined && !st.apiKeyConfigured}>
              <span className="provider-radio">{s.ai.provider === p && <Check />}</span>
              <span className="provider-text">
                <strong>{p === "anthropic_api" && keyIsDeepSeek ? t("apikey.provider.deepseek") : t(`settings.provider.${p}`)}</strong>
                <span className="field-hint">{optionHint(p)}</span>
              </span>
            </button>
          ))}
        </div>
        {s.ai.provider === "anthropic_api" && (
          <div className="callout callout-warning">
            <CircleAlert />
            <div>
              <strong>{deepseek ? t("apikey.deepseekTitle") : t("settings.apiTitle")}.</strong> {deepseek ? t("apikey.deepseekBody") : t("settings.apiBody")}{" "}
              {s.ai.apiBillingConsentAt && <span className="faint">({relativeTime(s.ai.apiBillingConsentAt, lang)})</span>}
              <div style={{ marginTop: 8 }}>
                <Button size="sm" onClick={() => void api.apiConsent(false).then(() => { void qc.invalidateQueries({ queryKey: ["bootstrap"] }); void qc.invalidateQueries({ queryKey: ["ai-status"] }); })}>
                  {t("settings.apiConsentRevoke")}
                </Button>
              </div>
            </div>
          </div>
        )}
      </Card>

      <ChatGptCard s={s} st={st} />
      <ApiKeyCard st={st} />

      <Card title={t("settings.connection")}>
        <div className="connection">
          <div className="row">
            <span className={`status-dot is-${stateTone === "success" ? "ready" : stateTone === "neutral" ? "off" : "warn"}`} />
            <strong>{st ? t(`ai.status.${st.state}` as Key) : t("ai.status.checking")}</strong>
            {st && (
              <Badge tone={st.billing === "api" ? "warning" : st.billing === "subscription" ? "success" : "neutral"}>
                {st.billing === "api" ? apiBilling : chatgpt ? t("chatgpt.billing") : t(`ai.billing.${st.billing}` as Key)}
              </Badge>
            )}
            <span className="spacer" />
            <Button size="sm" icon={checking ? <Spinner /> : <RefreshCw />} onClick={() => void check()} disabled={checking}>
              {t("settings.checkConnection")}
            </Button>
          </div>
          {st && <p className="muted connection-msg">{st.message}</p>}
          {st && (
            <dl className="kv">
              {st.detail.plan ? (
                <>
                  <dt>Plan</dt>
                  <dd>{String(st.detail.plan)}</dd>
                </>
              ) : null}
              {st.detail.version ? (
                <>
                  <dt>Claude Code</dt>
                  <dd className="tnum">{String(st.detail.version)}</dd>
                </>
              ) : null}
              {st.detail.binary ? (
                <>
                  <dt>{t("settings.claudePath")}</dt>
                  <dd className="truncate" title={String(st.detail.binary)}>
                    {String(st.detail.binary)}
                  </dd>
                </>
              ) : null}
              {st.lastModel && (
                <>
                  <dt>{t("ai.lastModel")}</dt>
                  <dd>
                    {modelLabel(st.lastModel)} <span className="faint">({st.lastModel})</span>
                  </dd>
                </>
              )}
              <dt>Effort</dt>
              <dd>{st.effortSupported ? st.efforts.join(" · ") : "—"}</dd>
              {st.rateLimit?.fiveHour && (
                <>
                  <dt>{t("ai.usage5h")}</dt>
                  <dd className="tnum">{t("ai.usedPct", { pct: Math.round(st.rateLimit.fiveHour.utilization * 100) })}</dd>
                </>
              )}
              {st.rateLimit?.sevenDay && (
                <>
                  <dt>{t("ai.usage7d")}</dt>
                  <dd className="tnum">{t("ai.usedPct", { pct: Math.round(st.rateLimit.sevenDay.utilization * 100) })}</dd>
                </>
              )}
            </dl>
          )}
        </div>
      </Card>

      <Card title={t("settings.model")} hint={t("settings.routingHint")}>
        {/* ChatGPT uses the one model chosen in its card: only the reasoning effort is set here. */}
        {!chatgpt && (
          <Row label={t("settings.model")}>
            <select className="select" style={{ width: 220 }} value={s.ai.modelMode} onChange={(e) => void save({ ai: { modelMode: e.target.value as Settings["ai"]["modelMode"] } })}>
              {(["auto", "haiku", "sonnet", "opus", "custom"] as const)
                .filter((m) => m !== "haiku" || offersHaiku(st) || s.ai.modelMode === "haiku")
                .map((m) => (
                  <option key={m} value={m}>
                    {deepseek && (m === "sonnet" || m === "opus") ? t(`apikey.model.${m}`) : t(`settings.model.${m}`)}
                  </option>
                ))}
            </select>
          </Row>
        )}
        {deepseek && <p className="field-hint">{t("apikey.deepseekRouting")}</p>}
        {offersHaiku(st) && <p className="field-hint">{t("apikey.haikuRouting")}</p>}
        {chatgpt && <p className="field-hint">{t("chatgpt.routing")}</p>}
        {!chatgpt && s.ai.modelMode === "custom" && (
          <Row label={t("settings.model.custom")}>
            <TextSetting value={s.ai.customModel} placeholder="claude-sonnet-5-5" onSave={(v) => void save({ ai: { customModel: v.trim() } })} />
          </Row>
        )}
        {/* DeepSeek has one model per kind of request and takes no effort setting. */}
        {!deepseek && (["simple", "moderate", "complex"] as const).map((lvl) => {
          const key = lvl === "simple" ? "effortSimple" : lvl === "moderate" ? "effortModerate" : "effortComplex";
          const name = chatgpt ? "ChatGPT" : lvl === "simple" && offersHaiku(st) && s.ai.modelMode === "auto" ? "Haiku" : "Sonnet";
          return (
            <Row key={lvl} label={t(`settings.effort.${lvl}`)}>
              {/* ChatGPT reasons at low, medium or high: xhigh is sent as high. */}
              <select className="select" style={{ width: 170 }} value={chatgpt && s.ai[key] === "xhigh" ? "high" : s.ai[key]} onChange={(e) => void save({ ai: { [key]: e.target.value } as SettingsPatch["ai"] })}>
                {(chatgpt ? ["low", "medium", "high"] : ["low", "medium", "high", "xhigh"]).map((x) => (
                  <option key={x} value={x}>
                    {name} · {x}
                  </option>
                ))}
              </select>
            </Row>
          );
        })}
        {!deepseek && !chatgpt && (
          <>
            <Row label={t("settings.opusEscalation")}>
              <Switch checked={s.ai.opusEscalation} onChange={(v) => void save({ ai: { opusEscalation: v } })} label={t("settings.opusEscalation")} />
            </Row>
            <Row label={t("settings.opusEffort")}>
              <select className="select" style={{ width: 140 }} value={s.ai.opusEffort} onChange={(e) => void save({ ai: { opusEffort: e.target.value as Settings["ai"]["opusEffort"] } })}>
                {["low", "medium", "high", "xhigh"].map((x) => (
                  <option key={x} value={x}>
                    Opus · {x}
                  </option>
                ))}
              </select>
            </Row>
          </>
        )}
      </Card>

      <Card title={t("settings.autoApply")} hint={t("settings.autoApplyHint")}>
        <Row label={t("settings.autoApply")}>
          <Switch checked={s.ai.autoApply === "minor"} onChange={(v) => void save({ ai: { autoApply: v ? "minor" : "never" } })} label={t("settings.autoApply")} />
        </Row>
        <Row label={t("settings.timeout")}>
          <select className="select" style={{ width: 120 }} value={s.ai.timeoutSec} onChange={(e) => void save({ ai: { timeoutSec: Number(e.target.value) } })}>
            {[60, 120, 180, 240, 360, 600].map((v) => (
              <option key={v} value={v}>
                {v}s
              </option>
            ))}
          </select>
        </Row>
        <Row label={t("settings.historyTurns")}>
          <select className="select" style={{ width: 120 }} value={s.ai.historyTurns} onChange={(e) => void save({ ai: { historyTurns: Number(e.target.value) } })}>
            {[4, 8, 12, 20, 30].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </Row>
        <Row label={t("settings.claudePath")} hint={t("settings.claudePathHint")}>
          <TextSetting value={s.ai.claudePath} placeholder={navigator.platform.startsWith("Win") ? "C:\\Users\\…\\.local\\bin\\claude.exe" : "~/.local/bin/claude"} width={260} onSave={(v) => void save({ ai: { claudePath: v.trim() } })} />
        </Row>
      </Card>

      <Disclosure st={st} />

      <Memory />

      <Card title={t("settings.selfTest")} hint={t("settings.selfTestHint")}>
        <div className="row">
          <Button
            icon={testing ? <Spinner /> : <ShieldCheck />}
            disabled={testing}
            onClick={async () => {
              setTesting(true);
              try {
                setSelfTest(await api.selfTest());
              } catch (err) {
                toast.error(errorMessage(err));
              } finally {
                setTesting(false);
              }
            }}
          >
            {t("settings.selfTestRun")}
          </Button>
          {selfTest && (
            <Badge tone={selfTest.passed ? "success" : "danger"}>{selfTest.passed ? t("settings.selfTestPassed", { n: selfTest.results.length }) : t("settings.selfTestFailed")}</Badge>
          )}
        </div>
        {selfTest && (
          <ul className="selftest">
            {selfTest.results.map((r) => (
              <li key={r.label}>
                {r.rejected ? <Check className="tone-success" /> : <X className="tone-danger" />}
                <span>{r.label}</span>
                <span className="faint truncate" title={r.error ?? ""}>
                  {r.error}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={t("settings.conversation")}>
        <Button
          variant="danger-ghost"
          icon={<Trash2 />}
          onClick={async () => {
            const { ok } = await confirmAction({ title: t("assistant.clearConfirm"), body: t("assistant.clearBody"), confirmLabel: t("assistant.clear"), cancelLabel: t("common.cancel"), danger: true });
            if (!ok) return;
            await api.clearConversation();
            void qc.invalidateQueries({ queryKey: ["conversation"] });
            toast.success(t("toast.saved"));
          }}
        >
          {t("assistant.clear")}
        </Button>
      </Card>
    </>
  );
}

function Shortcuts() {
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
  ];
  return (
    <Card title={t("shortcuts.title")} hint={t("shortcuts.globalNote")}>
      <ShortcutTable rows={rows} />
    </Card>
  );
}

/** Plain-language disclosure of what leaves the computer, with a live preview. */
function Disclosure({ st }: { st: AiStatus | undefined }) {
  const t = useT();
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof api.contextPreview>> | null>(null);
  const [loading, setLoading] = useState(false);
  const items: Key[] = ["privacy.sent.message", "privacy.sent.context", "privacy.sent.history", "privacy.sent.tools", "privacy.sent.notes"];
  // Requests go through Claude Code, to OpenAI with the ChatGPT sign-in, or to the service of the API key.
  const name = assistantName(st);
  const hint = usesChatGpt(st)
    ? t("privacy.hint.chatgpt")
    : st?.provider === "anthropic_api"
      ? t(usesDeepSeek(st) ? "privacy.hint.deepseek" : "privacy.hint.anthropic")
      : t("privacy.hint");
  return (
    <Card title={t("privacy.title", { name })} hint={hint}>
      <ul className="disclosure-list">
        {items.map((k) => (
          <li key={k}>
            <Check className="tone-success" />
            {t(k)}
          </li>
        ))}
        <li>
          <X className="faint" />
          {t("privacy.notSent")}
        </li>
      </ul>
      <div className="row">
        <Button
          size="sm"
          icon={loading ? <Spinner /> : <Eye />}
          onClick={async () => {
            setLoading(true);
            try {
              setPreview(await api.contextPreview());
            } catch (err) {
              toast.error(errorMessage(err));
            } finally {
              setLoading(false);
            }
          }}
        >
          {t("privacy.preview")}
        </Button>
      </div>
      <Dialog open={preview !== null} onClose={() => setPreview(null)} size="xl" title={t("privacy.previewTitle", { name })} labelledBy="preview-title">
        {preview && (
          <div className="dialog-body">
            <p className="field-hint">{t("privacy.previewHint", { n: preview.characters.toLocaleString(), turns: preview.historyTurns })}</p>
            <div className="section-title">{t("privacy.systemPrompt")}</div>
            <pre className="context-preview">{preview.system}</pre>
            <div className="section-title">{t("privacy.requestPrompt")}</div>
            <pre className="context-preview">{preview.prompt}</pre>
            <div className="section-title">{t("privacy.toolsTitle")}</div>
            <p className="field-hint">{preview.tools.join(", ")}</p>
          </div>
        )}
      </Dialog>
    </Card>
  );
}

function CalendarLinks() {
  const t = useT();
  const lang = useLang();
  const qc = useQueryClient();
  const feeds = useQuery({ queryKey: ["calendars"], queryFn: api.calendars });
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const work = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    try {
      await fn();
      invalidatePlanning(qc);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
      void feeds.refetch();
    }
  };
  const synced = (r: CalendarSyncResult) =>
    toast.success(r.created ? t("calendars.added", { name: r.feed.name, n: r.upcoming }) : t("calendars.refreshed", { added: r.added, updated: r.updated, removed: r.removed }));
  const add = () =>
    work("add", async () => {
      synced(await api.addCalendar(url.trim()));
      setUrl("");
    });
  const remove = async (f: CalendarFeed) => {
    const { ok } = await confirmAction({ title: t("calendars.removeTitle", { name: f.name }), body: t("calendars.removeBody", { n: f.eventCount }), confirmLabel: t("calendars.remove"), cancelLabel: t("common.cancel"), danger: true });
    if (ok) await work(f.id, async () => void (await api.removeCalendar(f.id)));
  };
  return (
    <Card title={t("calendars.title")} hint={t("calendars.hint")}>
      <ul className="memory-list">
        {(feeds.data ?? []).map((f) => (
          <li key={f.id}>
            <CalendarClock />
            <span className="stack" style={{ gap: 2, minWidth: 0 }}>
              <span className="truncate">{f.name}</span>
              <span className="faint" style={{ fontSize: "var(--text-xs)", ...(f.lastError ? { color: "var(--danger-text)" } : {}) }}>
                {f.lastError ? t("calendars.failed", { error: f.lastError }) : t("calendars.status", { n: f.eventCount, when: f.lastSyncAt ? relativeTime(f.lastSyncAt, lang) : "—" })}
              </span>
            </span>
            <button type="button" className="icon-btn icon-btn-sm" aria-label={t("calendars.refresh")} data-tip={t("calendars.refresh")} disabled={busy !== null} onClick={() => void work(f.id, async () => synced(await api.refreshCalendar(f.id)))}>
              {busy === f.id ? <Spinner /> : <RefreshCw />}
            </button>
            <button type="button" className="icon-btn icon-btn-sm" aria-label={t("calendars.remove")} data-tip={t("calendars.remove")} disabled={busy !== null} onClick={() => void remove(f)}>
              <Trash2 />
            </button>
          </li>
        ))}
      </ul>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <input
          className="input"
          style={{ flex: "1 1 220px", minWidth: 0 }}
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          value={url}
          placeholder={t("calendars.placeholder")}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && url.trim() && busy === null && void add()}
        />
        <Button icon={busy === "add" ? <Spinner /> : <Plus />} disabled={!url.trim() || busy !== null} onClick={() => void add()}>
          {t("calendars.add")}
        </Button>
      </div>
    </Card>
  );
}

function Memory() {
  const t = useT();
  const run = useAction();
  const q = useQuery({ queryKey: ["memory"], queryFn: api.memory });
  const [text, setText] = useState("");
  return (
    <Card title={t("settings.memory")} hint={t("settings.memoryHint")}>
      {q.data && q.data.length === 0 && <p className="faint">{t("settings.memoryEmpty")}</p>}
      <ul className="memory-list">
        {(q.data ?? []).map((m) => (
          <li key={m.id}>
            <Badge tone={m.source === "ai" ? "accent" : "neutral"}>{m.source === "ai" ? "AURA" : "You"}</Badge>
            <span>{m.text}</span>
            <button
              type="button"
              className="icon-btn icon-btn-sm"
              aria-label={t("common.delete")}
              onClick={async () => {
                await run(() => api.deleteMemory(m.id), { success: t("toast.saved"), undoLabel: t("common.undo") });
                void q.refetch();
              }}
            >
              <X />
            </button>
          </li>
        ))}
      </ul>
      <input
        className="input"
        value={text}
        placeholder={t("settings.memoryAdd")}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={async (e) => {
          if (e.key === "Enter" && text.trim().length >= 3) {
            const v = text.trim();
            setText("");
            await run(() => api.addMemory(v), { success: t("toast.saved"), undoLabel: t("common.undo") });
            void q.refetch();
          }
        }}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------

function Notifications({ s }: { s: Settings }) {
  const t = useT();
  const save = useSave();
  const denied = typeof Notification !== "undefined" && Notification.permission === "denied";
  return (
    <Card title={t("settings.notifications")} hint={t("settings.notificationsHint")}>
      <Row label={t("settings.notificationsEnable")} hint={denied ? t("settings.notificationsDenied") : undefined}>
        <Switch
          checked={s.notifications.enabled}
          disabled={denied}
          onChange={async (v) => {
            if (v && typeof Notification !== "undefined" && Notification.permission === "default") {
              const p = await Notification.requestPermission();
              if (p !== "granted") return;
            }
            await save({ notifications: { enabled: v } });
          }}
          label={t("settings.notificationsEnable")}
        />
      </Row>
      <Row label={t("settings.notificationsBefore")}>
        <select className="select" style={{ width: 120 }} value={s.notifications.minutesBefore} onChange={(e) => void save({ notifications: { minutesBefore: Number(e.target.value) } })} disabled={!s.notifications.enabled}>
          {minuteOptions([0, 1, 5, 10, 15, 30])}
        </select>
      </Row>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function DataSection({ dataDir, hasDemo }: { dataDir: string; hasDemo: boolean }) {
  const t = useT();
  const lang = useLang();
  const qc = useQueryClient();
  const run = useAction();
  const backups = useQuery({ queryKey: ["backups"], queryFn: api.backups });
  const history = useQuery({ queryKey: ["history"], queryFn: api.history });
  const jsonRef = useRef<HTMLInputElement | null>(null);
  const icsRef = useRef<HTMLInputElement | null>(null);
  const refreshAll = () => {
    invalidatePlanning(qc);
    void qc.invalidateQueries();
  };

  const importJson = async (file: File) => {
    let data: unknown;
    try {
      data = JSON.parse(await file.text());
    } catch {
      toast.error("This file is not valid JSON.");
      return;
    }
    const { ok } = await confirmAction({ title: t("settings.importConfirm"), body: t("settings.importBody"), confirmLabel: t("settings.import"), cancelLabel: t("common.cancel"), danger: true });
    if (!ok) return;
    try {
      const r = await api.importData(data);
      toast.success(`${r.tasks} tasks · ${r.projects} projects · ${r.events} events`);
      refreshAll();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <>
      <div className="callout callout-accent">
        <ShieldCheck />
        <div>{t("settings.localData")}</div>
      </div>
      <Card title={t("settings.data")}>
        <div className="row" style={{ flexWrap: "wrap" }}>
          <a className="btn" href="/api/data/export" download>
            <Download />
            {t("settings.export")}
          </a>
          <Button icon={<Upload />} onClick={() => jsonRef.current?.click()}>
            {t("settings.import")}
          </Button>
          <input ref={jsonRef} type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importJson(f); e.target.value = ""; }} />
        </div>
      </Card>
      <Card title={t("settings.calendarFiles")}>
        <div className="row" style={{ flexWrap: "wrap" }}>
          <a className="btn" href="/api/calendar/export.ics" download>
            <Download />
            {t("calendar.export")}
          </a>
          <Button icon={<Upload />} onClick={() => icsRef.current?.click()}>
            {t("calendar.import")}
          </Button>
          <input
            ref={icsRef}
            type="file"
            accept=".ics,text/calendar"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              try {
                const r = await api.importIcs(await f.text());
                toast.success(t("calendar.imported", { n: r.imported }));
                invalidatePlanning(qc);
              } catch (err) {
                toast.error(errorMessage(err));
              }
            }}
          />
        </div>
      </Card>
      <CalendarLinks />
      <Card title={t("settings.backups")} hint={t("settings.backupHint", { dir: `${dataDir}${dataDir.includes("\\") ? "\\" : "/"}backups` })}>
        <div className="row">
          <Button icon={<Database />} onClick={async () => { try { await api.createBackup(); void backups.refetch(); toast.success(t("toast.saved")); } catch (err) { toast.error(errorMessage(err)); } }}>
            {t("settings.backupNow")}
          </Button>
        </div>
        {backups.data && backups.data.length === 0 && <p className="faint">{t("settings.noBackups")}</p>}
        <ul className="backup-list">
          {(backups.data ?? []).slice(0, 8).map((b) => (
            <li key={b.name}>
              <span className="truncate tnum">{b.name.replace(/^aura-/, "").replace(/\.db$/, "")}</span>
              <span className="faint tnum">{Math.round(b.size / 1024)} KB · {relativeTime(b.createdAt, lang)}</span>
              <Button
                size="sm"
                variant="ghost"
                icon={<RotateCcw />}
                onClick={async () => {
                  const { ok } = await confirmAction({ title: t("settings.restoreConfirm"), body: t("settings.restoreBody"), confirmLabel: t("settings.restore"), cancelLabel: t("common.cancel"), danger: true });
                  if (!ok) return;
                  try {
                    await api.restoreBackup(b.name);
                    refreshAll();
                    toast.success(t("toast.saved"));
                  } catch (err) {
                    toast.error(errorMessage(err));
                  }
                }}
              >
                {t("settings.restore")}
              </Button>
            </li>
          ))}
        </ul>
      </Card>
      <Card title={t("settings.history")}>
        {history.data && history.data.length === 0 && <p className="faint">{t("settings.historyEmpty")}</p>}
        <ul className="history-list">
          {(history.data ?? []).slice(0, 15).map((h) => (
            <li key={h.id} className={h.undoneAt ? "is-undone" : ""}>
              <Badge tone={h.source === "ai" ? "accent" : h.source === "engine" ? "neutral" : "outline"}>{h.source === "ai" ? "AURA" : h.source === "engine" ? "Planner" : "You"}</Badge>
              <span className="truncate">{h.label}</span>
              <span className="faint tnum">{relativeTime(h.createdAt, lang)}</span>
              {!h.undoneAt && (
                <Button size="sm" variant="ghost" onClick={() => void run(() => api.undo(h.id), { success: t("toast.undone", { label: h.label }) }).then(() => void history.refetch())}>
                  {t("common.undo")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Card>
      <Card title={t("settings.demo")} hint={t("settings.demoHint")}>
        {hasDemo ? (
          <Button
            icon={<Trash2 />}
            onClick={async () => {
              await run(() => api.clearDemo(), { success: t("toast.saved"), undoLabel: t("common.undo") });
              void qc.invalidateQueries({ queryKey: ["bootstrap"] });
            }}
          >
            {t("settings.demoClear")}
          </Button>
        ) : (
          <Button
            icon={<Plus />}
            onClick={async () => {
              await run(() => api.loadDemo(), { success: t("toast.saved"), undoLabel: t("common.undo") });
              void qc.invalidateQueries({ queryKey: ["bootstrap"] });
            }}
          >
            {t("settings.demoLoad")}
          </Button>
        )}
      </Card>
      <Card title={t("settings.deleteAll")} hint={t("settings.deleteAllBody")}>
        <Button
          variant="danger"
          icon={<Trash2 />}
          onClick={async () => {
            const { ok, option } = await confirmAction({
              title: t("settings.deleteAll"),
              body: t("settings.deleteAllBody"),
              confirmLabel: t("settings.deleteAll"),
              cancelLabel: t("common.cancel"),
              danger: true,
              requireText: "DELETE",
              option: { label: t("settings.deleteAllBackup"), default: true },
            });
            if (!ok) return;
            try {
              await api.deleteAll(option);
              refreshAll();
              window.location.hash = "#/today";
            } catch (err) {
              toast.error(errorMessage(err));
            }
          }}
        >
          {t("settings.deleteAll")}
        </Button>
      </Card>
    </>
  );
}

const SERVICE_SHORT: Record<ApiService, string> = { anthropic: "Claude", deepseek: "DeepSeek" };

/** The API key (Claude or DeepSeek), recognized from its prefix and kept in a local file, never in the database. */
function ApiKeyCard({ st }: { st: AiStatus | undefined }) {
  const t = useT();
  const qc = useQueryClient();
  const [value, setValue] = useState("");
  const [choice, setChoice] = useState<ApiService | "auto">("auto");
  const [busy, setBusy] = useState(false);
  const saved = st?.apiService ?? null;
  const clean = value.trim();
  const detected = clean ? detectService(clean) : null;
  const service = choice !== "auto" ? choice : detected === "anthropic" || detected === "deepseek" ? detected : null;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["ai-status"] });
    void qc.invalidateQueries({ queryKey: ["bootstrap"] });
  };
  const save = async () => {
    if (!service) return;
    setBusy(true);
    try {
      const r = await api.saveApiKey(clean, service);
      const done = t(r.verified ? "apikey.verified" : "apikey.unverified", { service: SERVICE_SHORT[r.service] });
      // Another service turns the API off until its own billing is confirmed.
      toast.success(saved && saved !== r.service && st?.provider === "anthropic_api" ? `${done}. ${t("apikey.chooseAgain")}` : done);
      setValue("");
      setChoice("auto");
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    const { ok } = await confirmAction({ title: t("apikey.removeConfirm"), body: t("apikey.removeBody"), confirmLabel: t("apikey.remove"), cancelLabel: t("common.cancel"), danger: true });
    if (!ok) return;
    try {
      await api.removeApiKey();
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Card title={t("apikey.title")} hint={t("apikey.hint")}>
      {saved && (
        <div className="row" style={{ marginBottom: 10 }}>
          <Badge tone="success">{t("apikey.set", { service: SERVICE_SHORT[saved] })}</Badge>
        </div>
      )}
      <div className="row" style={{ flexWrap: "wrap" }}>
        <input
          className="input"
          type="password"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="sk-…"
          aria-label={t("apikey.title")}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          style={{ flex: "1 1 220px" }}
        />
        <select className="select" aria-label={t("apikey.service")} value={choice} onChange={(e) => setChoice(e.target.value as ApiService | "auto")} style={{ width: 170 }}>
          {(["auto", "anthropic", "deepseek"] as const).map((s) => (
            <option key={s} value={s}>
              {t(`apikey.service.${s}`)}
            </option>
          ))}
        </select>
        <Button variant="primary" icon={<KeyRound />} onClick={() => void save()} loading={busy} disabled={!service || detected === "subscription_token"}>
          {t("apikey.save")}
        </Button>
        {saved && (
          <Button variant="ghost" icon={<Trash2 />} onClick={() => void remove()}>
            {t("apikey.remove")}
          </Button>
        )}
      </div>
      {detected && choice === "auto" && (
        <p className="field-hint" role="status" style={{ marginTop: 8 }}>
          {detected === "anthropic" || detected === "deepseek" ? <Badge tone="success">{t(`apikey.detected.${detected}`)}</Badge> : t(`apikey.detected.${detected}`)}
        </p>
      )}
      {detected === "subscription_token" && choice !== "auto" && (
        <p className="field-hint" role="status" style={{ marginTop: 8 }}>
          {t("apikey.detected.subscription_token")}
        </p>
      )}
    </Card>
  );
}

/** Open OpenAI's sign-in page in this window; OpenAI sends the browser back to AURA's settings. */
async function signInWithChatGpt() {
  try {
    const { url } = await api.chatgptLogin();
    window.location.assign(url);
  } catch (err) {
    toast.error(errorMessage(err));
  }
}

/** The ChatGPT account: sign in with OpenAI, the plan in use, the model, and signing out. */
function ChatGptCard({ s, st }: { s: Settings; st: AiStatus | undefined }) {
  const t = useT();
  const qc = useQueryClient();
  const save = useSave();
  const account = st?.chatgpt ?? null;
  const models = useQuery({ queryKey: ["chatgpt-models"], queryFn: api.chatgptModels, enabled: Boolean(account?.planUsage), staleTime: 10 * 60_000 });
  const list = models.data ?? [];

  const signOut = async () => {
    const { ok } = await confirmAction({ title: t("chatgpt.signOutConfirm"), body: t("chatgpt.signOutBody"), confirmLabel: t("chatgpt.signOut"), cancelLabel: t("common.cancel") });
    if (!ok) return;
    try {
      const r = await api.chatgptLogout();
      if (r.revoked) toast.success(t("chatgpt.signedOut"));
      else toast.error(t("chatgpt.notRevoked"));
      void qc.invalidateQueries({ queryKey: ["ai-status"] });
      void qc.invalidateQueries({ queryKey: ["bootstrap"] });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Card title={t("chatgpt.title")} hint={t("chatgpt.hint")}>
      {account ? (
        <>
          <div className="row" style={{ flexWrap: "wrap", marginBottom: 10 }}>
            <span>{account.email ? t("chatgpt.signedIn", { email: account.email }) : t("chatgpt.signedInNoEmail")}</span>
            {account.planUsage && s.ai.provider === "chatgpt" && <Badge tone="success">{t("chatgpt.inUse")}</Badge>}
            <span className="spacer" />
            <a className="btn btn-ghost btn-sm" href={MANAGE_USAGE_URL} target="_blank" rel="noreferrer">
              {t("chatgpt.manageUsage")}
            </a>
            <Button size="sm" variant="ghost" onClick={() => void signOut()}>
              {t("chatgpt.signOut")}
            </Button>
          </div>
          {!account.planUsage && (
            <div className="callout callout-warning">
              <CircleAlert />
              <div>{t("chatgpt.noPlanUsage")}</div>
            </div>
          )}
          {account.planUsage && list.length > 0 && (
            <Row label={t("chatgpt.model")}>
              <select className="select" style={{ width: 220 }} value={s.ai.chatgptModel} onChange={(e) => void save({ ai: { chatgptModel: e.target.value } })}>
                <option value="">{t("chatgpt.modelDefault", { name: list[0]!.label })}</option>
                {list.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </Row>
          )}
        </>
      ) : (
        <Button className="btn-chatgpt" onClick={() => void (async () => {
          const { ok } = await confirmAction({ title: t("chatgpt.consentDialog"), body: t("chatgpt.consentBody"), confirmLabel: t("chatgpt.continue"), cancelLabel: t("common.cancel") });
          if (ok) await signInWithChatGpt();
        })()}>
          {t("chatgpt.continue")}
        </Button>
      )}
    </Card>
  );
}

/** Shown once, after the first sign-in with ChatGPT plan usage (OpenAI's sign-in sends the browser back with chatgpt=welcome). */
function ChatGptWelcome() {
  const t = useT();
  const ui = useUi();
  const [open, setOpen] = useState(() => window.location.hash.includes("chatgpt=welcome"));
  useEffect(() => {
    if (window.location.hash.includes("chatgpt=signed-in")) toast.success(t("chatgpt.signedInToast"));
    // Drop the marker from the address so a reload does not show it again.
    if (window.location.hash.includes("chatgpt=")) ui.setView("settings", { settingsSection: "assistant" });
  }, [t, ui]);
  return (
    <Dialog open={open} onClose={() => setOpen(false)} size="sm" title={t("chatgpt.welcomeTitle")} labelledBy="chatgpt-welcome">
      <div className="dialog-body">
        <p>{t("chatgpt.welcomeBody")}</p>
      </div>
      <div className="dialog-footer">
        <a className="btn btn-ghost" href={MANAGE_USAGE_URL} target="_blank" rel="noreferrer">
          {t("chatgpt.manageUsage")}
        </a>
        <Button variant="primary" onClick={() => setOpen(false)}>
          {t("chatgpt.welcomeOk")}
        </Button>
      </div>
    </Dialog>
  );
}
