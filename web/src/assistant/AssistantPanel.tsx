import { useQueryClient } from "@tanstack/react-query";
import {
  ALargeSmall,
  AlertCircle,
  ArrowUp,
  Check,
  ChevronDown,
  CircleStop,
  Gauge,
  KeyRound,
  RefreshCw,
  Settings2,
  Sparkles,
  Terminal,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AiStatus, ChatMessage, Proposal, RoutingDecision } from "@shared/api";
import { ProposalView } from "../components/ProposalView";
import { ResizeHandle } from "../components/ResizeHandle";
import { Badge, Button, confirmAction, IconButton, Menu, Popover, Segmented, Spinner } from "../components/ui";
import { api, ApiError, streamChat } from "../lib/api";
import { modelLabel, relativeTime } from "../lib/format";
import { useLang, useT, type Key, type T } from "../lib/i18n";
import { Markdown } from "../lib/markdown";
import { MANAGE_USAGE_URL, modelChoiceName, offersHaiku, usesChatGpt, usesDeepSeek } from "../lib/platform";
import { errorMessage, invalidatePlanning, useAiStatus, useConversation } from "../lib/queries";
import { ASSISTANT_DOCK_MIN, ASSISTANT_W, MAIN_MIN_W, useUi, widthOf, type BubbleWidth, type ChatText } from "../lib/store";
import { toast } from "../lib/toast";

type ModelChoice = "auto" | "haiku" | "sonnet" | "opus";
type EffortChoice = "auto" | "low" | "medium" | "high" | "xhigh";

interface Streaming {
  userText: string;
  routing: RoutingDecision | null;
  text: string;
  status: string;
  tools: { name: string; ok: boolean }[];
}

const READ_TOOLS = new Set(["get_day", "list_tasks", "get_task", "list_projects", "list_events", "upcoming_deadlines", "find_free_time", "check_conflicts", "get_progress", "suggest_next", "get_preferences", "review_period"]);

function toolPhase(name: string): Key {
  if (name === "plan_day" || name === "plan_range") return "assistant.tool.plan";
  return READ_TOOLS.has(name) ? "assistant.tool.read" : "assistant.tool.write";
}

export function AssistantPanel() {
  const t = useT();
  const ui = useUi();
  const qc = useQueryClient();
  const convo = useConversation();
  const status = useAiStatus();
  const [streaming, setStreaming] = useState<Streaming | null>(null);
  const [input, setInput] = useState("");
  const [model, setModel] = useState<ModelChoice>("auto");
  const [effort, setEffort] = useState<EffortChoice>("auto");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const st = status.data;
  const ready = st?.state === "ready";

  const messages = convo.data?.messages ?? [];
  const proposals = useMemo(() => new Map((convo.data?.proposals ?? []).map((p) => [p.id, p])), [convo.data]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, streaming?.text, streaming?.tools.length, streaming?.userText]);

  const send = useCallback(
    async (text: string, opts: { retryOf?: string; model?: ModelChoice } = {}) => {
      const message = text.trim();
      if ((!message && !opts.retryOf) || streaming) return;
      setInput("");
      if (inputRef.current) inputRef.current.style.height = "auto";
      setStreaming({ userText: opts.retryOf ? "" : message, routing: null, text: "", status: "thinking", tools: [] });
      try {
        await streamChat(
          {
            message,
            ...((opts.model ?? model) !== "auto" ? { model: opts.model ?? model } : {}),
            ...(effort !== "auto" && !usesDeepSeek(st) ? { effort } : {}),
            ...(opts.retryOf ? { retryOf: opts.retryOf } : {}),
          },
          (e) => {
            if (e.type === "accepted") setStreaming((s) => (s ? { ...s, routing: e.routing, userText: e.userMessage.content } : s));
            else if (e.type === "text") setStreaming((s) => (s ? { ...s, text: s.text + e.delta } : s));
            else if (e.type === "status") setStreaming((s) => (s ? { ...s, status: e.text, text: e.text === "continuing" ? "" : s.text } : s));
            else if (e.type === "tool") setStreaming((s) => (s ? { ...s, tools: [...s.tools, { name: e.name, ok: e.ok }] } : s));
            else if (e.type === "done") {
              invalidatePlanning(qc);
              if (e.proposal?.status === "auto_applied") toast.success(t("proposal.auto_applied"));
            } else if (e.type === "fatal") toast.error(e.message);
          },
        );
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : errorMessage(err));
        setInput(message);
      } finally {
        await qc.invalidateQueries({ queryKey: ["conversation"] });
        void qc.invalidateQueries({ queryKey: ["ai-status"] });
        setStreaming(null);
      }
    },
    [streaming, model, effort, st, qc, t],
  );

  // Text handed over from elsewhere in the app (quick add, morning planning, empty states).
  useEffect(() => {
    const draft = ui.assistantDraft;
    if (!draft) return;
    ui.set({ assistantDraft: null });
    if (draft.send && ready && draft.text) void send(draft.text);
    else {
      setInput(draft.text);
      window.setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [ui.assistantDraft, ready, send, ui]);

  useEffect(() => {
    const onFocus = () => inputRef.current?.focus();
    window.addEventListener("aura:focus-assistant", onFocus);
    return () => window.removeEventListener("aura:focus-assistant", onFocus);
  }, []);

  const clear = async () => {
    const { ok } = await confirmAction({ title: t("assistant.clearConfirm"), body: t("assistant.clearBody"), confirmLabel: t("assistant.clear"), cancelLabel: t("common.cancel"), danger: true });
    if (!ok) return;
    await api.clearConversation();
    void qc.invalidateQueries({ queryKey: ["conversation"] });
  };

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");

  return (
    <aside className="assistant" aria-label={t("assistant.title")} data-text={ui.chatText} data-bubbles={ui.bubbleW}>
      <ResizeHandle
        edge="left"
        cssVar="--assistant-w"
        range={ASSISTANT_W}
        value={ui.assistantW}
        measure={() => widthOf(".assistant")}
        available={() => (window.innerWidth >= ASSISTANT_DOCK_MIN ? window.innerWidth - widthOf(".sidebar") - MAIN_MIN_W : window.innerWidth - 16)}
        label={t("layout.resizeAssistant")}
        onCommit={(w) => ui.set({ assistantW: w })}
      />
      <header className="as-header">
        <div className="as-title">
          <Sparkles />
          <span>{t("assistant.title")}</span>
        </div>
        <StatusPill status={status.data} loading={status.isLoading} lastRouting={lastAssistant?.meta.routing ?? null} onRecheck={() => void qc.fetchQuery({ queryKey: ["ai-status"], queryFn: () => api.aiStatus(true) })} />
        <span className="spacer" />
        <ChatDisplay />
        {messages.length > 0 && (
          <IconButton label={t("assistant.clear")} onClick={() => void clear()} disabled={Boolean(streaming)}>
            <Trash2 />
          </IconButton>
        )}
        <IconButton label={t("assistant.close")} onClick={() => ui.toggleAssistant(false)} tipPos="left">
          <X />
        </IconButton>
      </header>

      <div className="as-messages" ref={scrollRef}>
        {messages.length === 0 && !streaming && <AssistantEmpty ready={ready} onPick={(s) => (ready ? void send(s) : setInput(s))} />}
        {messages.map((m) => (
          <MessageView
            key={m.id}
            message={m}
            proposal={m.meta.proposalId ? proposals.get(m.meta.proposalId) : undefined}
            isLastAssistant={m.id === lastAssistant?.id}
            busy={Boolean(streaming)}
            retryLabel={usesChatGpt(st) ? t("assistant.retryHarder") : usesDeepSeek(st) ? t("assistant.retryPro") : t("assistant.retryOpus")}
            onRetry={(modelOverride) => {
              const original = m.meta.retryOf ?? (lastUser && m.id === lastAssistant?.id ? lastUser.id : undefined);
              if (original) void send("", { retryOf: original, ...(modelOverride ? { model: modelOverride } : {}) });
            }}
          />
        ))}
        {streaming && <StreamingView s={streaming} />}
      </div>

      {!ready && status.data && <NotReady status={status.data} />}

      <div className="composer">
        <div className={`composer-box ${!ready ? "is-disabled" : ""}`}>
          <textarea
            ref={inputRef}
            value={input}
            rows={1}
            placeholder={ready ? t("assistant.placeholder") : t("assistant.placeholderOff")}
            aria-label={t("assistant.placeholder")}
            disabled={!ready}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(input);
              }
            }}
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
            }}
          />
          <div className="composer-tools">
            {/* ChatGPT uses one model: only the effort is chosen per message. */}
            {!usesChatGpt(st) && (
              <Menu
                label={t("settings.model")}
                items={(["auto", ...(offersHaiku(st) ? ["haiku"] : []), "sonnet", "opus"] as ModelChoice[]).map((v) => ({
                  label: v === "auto" ? t("assistant.modelAuto") : modelChoiceName(v, st),
                  icon: model === v ? <Check /> : <span style={{ width: 15 }} />,
                  onSelect: () => setModel(v),
                }))}
                trigger={(p) => (
                  <button type="button" className="composer-chip" {...p} disabled={!ready}>
                    {model === "auto" ? t("assistant.modelAuto") : modelChoiceName(model, st)}
                    <ChevronDown />
                  </button>
                )}
              />
            )}
            {/* DeepSeek takes no effort setting. */}
            {!usesDeepSeek(st) && (
              <Menu
                label="Effort"
                items={((usesChatGpt(st) ? ["auto", "low", "medium", "high"] : ["auto", "low", "medium", "high", "xhigh"]) as EffortChoice[]).map((v) => ({
                  label: v === "auto" ? t("assistant.effortAuto") : v,
                  icon: effort === v ? <Check /> : <span style={{ width: 15 }} />,
                  onSelect: () => setEffort(v),
                }))}
                trigger={(p) => (
                  <button type="button" className="composer-chip" {...p} disabled={!ready}>
                    <Gauge />
                    {effort === "auto" ? t("assistant.effortAuto") : effort}
                    <ChevronDown />
                  </button>
                )}
              />
            )}
            <span className="spacer" />
            {streaming ? (
              <Button variant="secondary" size="sm" icon={<CircleStop />} onClick={() => void api.cancelChat()}>
                {t("assistant.stop")}
              </Button>
            ) : (
              <button type="button" className="send-btn" aria-label={t("assistant.send")} disabled={!ready || !input.trim()} onClick={() => void send(input)}>
                <ArrowUp />
              </button>
            )}
          </div>
        </div>
        <div className="composer-hint">{t("assistant.shiftEnter")}</div>
        {usesChatGpt(st) && (
          <div className="composer-plan">
            {t("chatgpt.inUse")} ·{" "}
            <a href={MANAGE_USAGE_URL} target="_blank" rel="noreferrer">
              {t("chatgpt.manageUsage")}
            </a>
          </div>
        )}
      </div>
    </aside>
  );
}

function AssistantEmpty({ ready, onPick }: { ready: boolean; onPick: (s: string) => void }) {
  const t = useT();
  const suggestions: Key[] = ["assistant.suggest.plan", "assistant.suggest.now", "assistant.suggest.delay", "assistant.suggest.tired", "assistant.suggest.block"];
  return (
    <div className="as-empty">
      <div className="as-empty-mark">
        <Sparkles />
      </div>
      <h3>{t("assistant.empty.title")}</h3>
      <p>{t("assistant.empty.body")}</p>
      <div className="as-suggestions">
        {suggestions.map((k) => (
          <button key={k} type="button" className="as-suggestion" onClick={() => onPick(t(k))} disabled={!ready}>
            {t(k)}
          </button>
        ))}
      </div>
    </div>
  );
}

function StreamingView({ s }: { s: Streaming }) {
  const t = useT();
  const phases = [...new Set(s.tools.map((x) => toolPhase(x.name)))];
  const failed = s.tools.filter((x) => !x.ok).length;
  return (
    <>
      {s.userText && (
        <div className="msg msg-user">
          <div className="msg-bubble">{s.userText}</div>
        </div>
      )}
      <div className="msg msg-assistant is-streaming">
        {s.routing && (
          <div className="msg-route">
            {s.routing.effort
              ? t("assistant.routed", { level: t(`assistant.level.${s.routing.level}` as Key), model: s.routing.modelLabel, effort: s.routing.effort })
              : `${t(`assistant.level.${s.routing.level}` as Key)} · ${s.routing.modelLabel}`}
          </div>
        )}
        {s.text ? <Markdown text={s.text} /> : null}
        <div className="msg-progress">
          <Spinner />
          <span>{phases.length ? t(phases[phases.length - 1]!) : t("assistant.thinking")}</span>
          {s.tools.length > 0 && (
            <span className="faint tnum">
              · {s.tools.length} {s.tools.length === 1 ? "action" : "actions"}
              {failed ? ` (${failed} rejected)` : ""}
            </span>
          )}
        </div>
      </div>
    </>
  );
}

function MessageView({
  message,
  proposal,
  isLastAssistant,
  busy,
  retryLabel,
  onRetry,
}: {
  message: ChatMessage;
  proposal?: Proposal;
  isLastAssistant: boolean;
  busy: boolean;
  retryLabel: string;
  onRetry: (model?: ModelChoice) => void;
}) {
  const t = useT();
  const lang = useLang();
  if (message.role === "user") {
    return (
      <div className="msg msg-user">
        <div className="msg-bubble">{message.content}</div>
      </div>
    );
  }
  const meta = message.meta;
  if (meta.status === "error") {
    return (
      <div className="msg msg-assistant">
        <ErrorCallout code={meta.error?.code ?? "unknown"} message={message.content} suggestion={meta.error?.suggestion} onRetry={isLastAssistant && !busy ? () => onRetry() : undefined} t={t} />
      </div>
    );
  }
  const rejected = (meta.toolCalls ?? []).filter((c) => !c.ok).length;
  if (meta.local) {
    return (
      <div className="msg msg-assistant">
        <Markdown text={message.content} />
        <div className="msg-meta">
          <span>{t("assistant.local")}</span>
          <span>· {relativeTime(message.createdAt, lang)}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="msg msg-assistant">
      <Markdown text={message.content} />
      {proposal && <ProposalView proposal={proposal} compact />}
      <div className="msg-meta">
        <span title={meta.routing ? `${meta.routing.reason} (${meta.routing.signals.join(", ") || "no signals"})` : undefined}>
          {modelLabel(meta.model)}
          {meta.effort ? ` · ${meta.effort}` : ""}
          {meta.routing ? ` · ${t(`assistant.level.${meta.routing.level}` as Key).toLowerCase()}` : ""}
        </span>
        {meta.durationMs ? <span className="tnum">· {(meta.durationMs / 1000).toFixed(1)}s</span> : null}
        {rejected > 0 && (
          <span title="Invalid actions were rejected by validation and not applied.">
            · <Wrench className="msg-meta-icon" /> {rejected}
          </span>
        )}
        <span>· {relativeTime(message.createdAt, lang)}</span>
        {isLastAssistant && !busy && !/opus|deepseek-.*pro/.test(meta.model ?? "") && (
          <button type="button" className="msg-action" onClick={() => onRetry("opus")}>
            {retryLabel}
          </button>
        )}
      </div>
    </div>
  );
}

function ErrorCallout({
  code,
  message,
  suggestion,
  onRetry,
  t,
}: {
  code: string;
  message: string;
  suggestion?: string;
  onRetry?: () => void;
  t: T;
}) {
  return (
    <div className="callout callout-danger msg-error" role="alert">
      <AlertCircle />
      <div className="stack" style={{ gap: 8 }}>
        <div>{message}</div>
        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          {onRetry && (suggestion === "retry" || code === "timeout" || code === "network" || code === "overloaded" || code === "unknown" || code === "cancelled") && (
            <Button size="sm" icon={<RefreshCw />} onClick={onRetry}>
              {t("assistant.retry")}
            </Button>
          )}
          {(suggestion === "settings" || suggestion === "switch_to_api") && (
            <Button size="sm" icon={suggestion === "switch_to_api" ? <KeyRound /> : <Settings2 />} onClick={openAssistantSettings}>
              {suggestion === "switch_to_api" ? t("assistant.switchApi") : t("assistant.openSettings")}
            </Button>
          )}
          {(suggestion === "login" || suggestion === "install") && (
            <code className="inline-code">
              <Terminal />
              {suggestion === "login" ? "claude auth login" : "code.claude.com/docs"}
            </code>
          )}
        </div>
      </div>
    </div>
  );
}

function NotReady({ status }: { status: AiStatus }) {
  const t = useT();
  const qc = useQueryClient();
  const [checking, setChecking] = useState(false);
  const off = status.state === "disabled";
  return (
    <div className="as-notready">
      <div className="as-notready-title">{off ? t("assistant.offTitle") : t("assistant.notReadyTitle")}</div>
      <p>{status.message}</p>
      <div className="row">
        {!off && (
          <Button
            size="sm"
            icon={checking ? <Spinner /> : <RefreshCw />}
            onClick={async () => {
              setChecking(true);
              try {
                await qc.fetchQuery({ queryKey: ["ai-status"], queryFn: () => api.aiStatus(true) });
              } finally {
                setChecking(false);
              }
            }}
          >
            {t("assistant.checkAgain")}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={openAssistantSettings}>
          {t("assistant.openSettings")}
        </Button>
      </div>
    </div>
  );
}

/** Show Settings > Assistant. Below the docking width the panel covers the page, so it closes too. */
function openAssistantSettings() {
  const ui = useUi.getState();
  ui.setView("settings", { settingsSection: "assistant" });
  if (window.innerWidth < ASSISTANT_DOCK_MIN) ui.toggleAssistant(false);
}

function UsageBar({ label, window }: { label: string; window: { utilization: number; resetsAt: number } | null }) {
  const t = useT();
  const lang = useLang();
  if (!window) return null;
  const pct = Math.round(window.utilization * 100);
  const resets = new Date(window.resetsAt * 1000);
  const when = new Intl.DateTimeFormat(lang === "fr" ? "fr-FR" : "en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(resets);
  return (
    <div className="usage">
      <div className="usage-row">
        <span>{label}</span>
        <span className="tnum faint">
          {t("ai.usedPct", { pct })} · {t("ai.resets", { when })}
        </span>
      </div>
      <div className={`progress ${pct > 85 ? "load-danger" : pct > 60 ? "load-warning" : ""}`}>
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Text size and bubble width of the conversation (remembered in this window). */
function ChatDisplay() {
  const t = useT();
  const ui = useUi();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement | null>(null);
  const isDefault = ui.chatText === "md" && ui.bubbleW === "normal" && ui.assistantW === ASSISTANT_W.default;
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="icon-btn"
        aria-label={t("assistant.display")}
        {...(open ? {} : { "data-tip": t("assistant.display"), "data-tip-pos": "left" })}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <ALargeSmall />
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} align="end" width={300}>
        <div className="chat-display">
          <div className="chat-display-row">
            <span className="chat-display-label">{t("assistant.textSize")}</span>
            <Segmented<ChatText>
              label={t("assistant.textSize")}
              value={ui.chatText}
              onChange={(v) => ui.set({ chatText: v })}
              options={[
                { value: "sm", label: t("assistant.textSize.sm") },
                { value: "md", label: t("assistant.textSize.md") },
                { value: "lg", label: t("assistant.textSize.lg") },
              ]}
            />
          </div>
          <div className="chat-display-row">
            <span className="chat-display-label">{t("assistant.bubbles")}</span>
            <Segmented<BubbleWidth>
              label={t("assistant.bubbles")}
              value={ui.bubbleW}
              onChange={(v) => ui.set({ bubbleW: v })}
              options={[
                { value: "narrow", label: t("assistant.bubbles.narrow") },
                { value: "normal", label: t("assistant.bubbles.normal") },
                { value: "wide", label: t("assistant.bubbles.wide") },
              ]}
            />
          </div>
          <p className="chat-display-hint">{t("assistant.resizeHint")}</p>
          <div className="row">
            <Button size="sm" variant="ghost" disabled={isDefault} onClick={() => ui.set({ chatText: "md", bubbleW: "normal", assistantW: ASSISTANT_W.default })}>
              {t("assistant.displayReset")}
            </Button>
          </div>
        </div>
      </Popover>
    </>
  );
}

function StatusPill({ status, loading, lastRouting, onRecheck }: { status?: AiStatus; loading: boolean; lastRouting: RoutingDecision | null; onRecheck: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement | null>(null);
  const state = loading ? "checking" : (status?.state ?? "checking");
  const tone = state === "ready" ? "ready" : state === "disabled" ? "off" : state === "checking" ? "checking" : "warn";
  const plan = status?.detail.plan ? String(status.detail.plan) : null;
  const label =
    state === "ready"
      ? status?.lastModel
        ? modelLabel(status.lastModel)
        : status?.provider === "anthropic_api"
          ? "API"
          : status?.provider === "chatgpt"
            ? "ChatGPT"
            : plan
            ? `Claude · ${plan[0]!.toUpperCase()}${plan.slice(1)}`
            : "Claude"
      : t(`ai.status.${state}` as Key);
  return (
    <>
      <button ref={ref} type="button" className={`status-pill is-${tone}`} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={`${t("settings.connection")}: ${label}`}>
        <span className="status-dot" />
        {label}
        {status?.billing === "api" && state === "ready" && <span className="status-billed">$</span>}
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} width={300}>
        {status ? (
          <div className="status-pop">
            <div className="status-pop-head">
              <span className={`status-dot is-${tone}`} />
              <strong>{status.provider === "claude_code" ? t("assistant.subscription") : status.provider === "chatgpt" ? t("settings.provider.chatgpt") : status.provider === "anthropic_api" ? (usesDeepSeek(status) ? t("apikey.billedDeepseek") : t("assistant.billedApi")) : t("assistant.off")}</strong>
              <span className="spacer" />
              <Badge tone={tone === "ready" ? "success" : tone === "warn" ? "warning" : "neutral"}>{t(`ai.status.${state}` as Key)}</Badge>
            </div>
            <p className="status-pop-msg">{status.message}</p>
            <div className="status-pop-grid">
              <span className="faint">{status.billing === "api" && usesDeepSeek(status) ? t("apikey.billing.deepseek") : usesChatGpt(status) ? t("chatgpt.billing") : t("ai.billing." + status.billing as Key)}</span>
              {status.lastModel && (
                <>
                  <span className="faint">{t("ai.lastModel")}</span>
                  <span className="tnum">{status.lastModel}</span>
                </>
              )}
              {lastRouting && (
                <>
                  <span className="faint">{t("ai.lastRoute")}</span>
                  <span>
                    {t(`assistant.level.${lastRouting.level}` as Key)} → {lastRouting.modelLabel}
                    {lastRouting.effort ? ` · ${lastRouting.effort}` : ""}
                  </span>
                </>
              )}
              {status.detail.version ? (
                <>
                  <span className="faint">Claude Code</span>
                  <span className="tnum">{String(status.detail.version)}</span>
                </>
              ) : null}
            </div>
            {status.rateLimit && (status.rateLimit.fiveHour || status.rateLimit.sevenDay) && (
              <div className="stack" style={{ gap: 8, marginTop: 10 }}>
                <UsageBar label={t("ai.usage5h")} window={status.rateLimit.fiveHour} />
                <UsageBar label={t("ai.usage7d")} window={status.rateLimit.sevenDay} />
              </div>
            )}
            <div className="row" style={{ marginTop: 12 }}>
              <Button size="sm" icon={<RefreshCw />} onClick={onRecheck}>
                {t("assistant.checkAgain")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setOpen(false); openAssistantSettings(); }}>
                {t("assistant.openSettings")}
              </Button>
            </div>
          </div>
        ) : (
          <Spinner />
        )}
      </Popover>
    </>
  );
}
