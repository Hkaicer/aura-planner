import { Calendar, Clock, Flag, FolderClosed, Hash, Hourglass, Inbox, Sparkles, Timer } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { parseQuickAdd } from "@shared/quickadd";
import type { TaskCreate } from "@shared/schemas";
import { combine } from "@shared/time";
import { api } from "../lib/api";
import { relativeDay } from "../lib/format";
import { useLang, useT } from "../lib/i18n";
import { useAction, useAiStatus, useNow, useProjects } from "../lib/queries";
import { useUi } from "../lib/store";
import { Button, Dialog, Kbd } from "./ui";

export function QuickAddHost() {
  const ui = useUi();
  if (!ui.quickAdd) return null;
  return <QuickAdd key={JSON.stringify(ui.quickAdd)} onClose={() => ui.set({ quickAdd: null })} />;
}

function QuickAdd({ onClose }: { onClose: () => void }) {
  const t = useT();
  const lang = useLang();
  const ui = useUi();
  const now = useNow();
  const projects = useProjects();
  const ai = useAiStatus();
  const run = useAction();
  const defaults = ui.quickAdd ?? {};
  const [text, setText] = useState(defaults.text ?? "");
  const [saving, setSaving] = useState(false);
  const parsed = useMemo(() => parseQuickAdd(text, now.date), [text, now.date]);
  const project = parsed.project ? (projects.data ?? []).find((p) => p.name.toLowerCase() === parsed.project!.toLowerCase()) : undefined;
  const plannedDate = parsed.plannedDate ?? defaults.plannedDate ?? null;
  const start = parsed.start ?? defaults.start ?? null;
  const projectId = project?.id ?? defaults.projectId ?? null;
  const multiLine = text.includes("\n") || text.length > 160;

  useEffect(() => setText(defaults.text ?? ""), [defaults.text]);

  const create = async (inbox = false) => {
    const title = parsed.title || text.trim();
    if (!title) return;
    setSaving(true);
    const body: TaskCreate = {
      title,
      ...(parsed.priority ? { priority: parsed.priority } : {}),
      ...(parsed.estimateMin ? { estimateMin: parsed.estimateMin } : {}),
      ...(parsed.tags.length ? { tags: parsed.tags } : {}),
      ...(projectId ? { projectId } : {}),
      ...(parsed.dueDate ? { dueAt: combine(parsed.dueDate, "23:59") } : {}),
      ...(inbox
        ? { status: "inbox" as const }
        : plannedDate && start
          ? { scheduledStart: combine(plannedDate, start), pinned: true }
          : plannedDate
            ? { plannedDate }
            : {}),
    };
    const res = await run(() => api.createTask(body), { success: t("toast.created", { title }), undoLabel: t("common.undo") });
    setSaving(false);
    if (res) onClose();
  };

  const askAura = () => {
    onClose();
    ui.askAssistant(text, true);
  };

  return (
    <Dialog open onClose={onClose} size="lg" labelledBy="quick-add-title">
      <div className="quick-add">
        <h2 id="quick-add-title" className="sr-only">
          {t("nav.newTask")}
        </h2>
        <textarea
          className="quick-input"
          value={text}
          rows={multiLine ? 4 : 1}
          placeholder={t("quick.placeholder")}
          aria-label={t("nav.newTask")}
          data-autofocus
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (e.ctrlKey || e.metaKey) askAura();
              else void create();
            }
          }}
        />
        <div className="quick-tokens">
          {plannedDate && (
            <span className="chip">
              <Calendar />
              {relativeDay(plannedDate, now.date, lang, t)}
            </span>
          )}
          {start && (
            <span className="chip">
              <Clock />
              {start}
            </span>
          )}
          {parsed.estimateMin && (
            <span className="chip">
              <Hourglass />
              {parsed.estimateMin} min
            </span>
          )}
          {parsed.priority && (
            <span className="chip">
              <Flag />
              {t(`priority.${parsed.priority}`)}
            </span>
          )}
          {(project || defaults.projectId) && (
            <span className="chip">
              <FolderClosed />
              {project?.name ?? (projects.data ?? []).find((p) => p.id === defaults.projectId)?.name}
            </span>
          )}
          {parsed.project && !project && (
            <span className="chip chip-warn" title="Unknown project">
              <FolderClosed />+{parsed.project}?
            </span>
          )}
          {parsed.dueDate && (
            <span className="chip">
              <Timer />
              {t("task.due")} {relativeDay(parsed.dueDate, now.date, lang, t)}
            </span>
          )}
          {parsed.tags.map((tag) => (
            <span key={tag} className="chip">
              <Hash />
              {tag}
            </span>
          ))}
          {!plannedDate && !start && parsed.tokens.length === 0 && <span className="faint quick-hint">{t("quick.hint")}</span>}
        </div>
      </div>
      <div className="dialog-footer quick-footer">
        <Button variant="ghost" icon={<Sparkles />} onClick={askAura} disabled={!text.trim() || ai.data?.state !== "ready"} title={ai.data?.state === "ready" ? undefined : ai.data?.message}>
          {t("quick.askAura")}
          <Kbd>Ctrl ↵</Kbd>
        </Button>
        <span className="spacer" />
        <Button variant="ghost" icon={<Inbox />} onClick={() => void create(true)} disabled={!text.trim() || saving}>
          {t("quick.toInbox")}
        </Button>
        <Button variant="primary" onClick={() => void create()} loading={saving} disabled={!text.trim()}>
          {t("quick.add")}
          <Kbd>↵</Kbd>
        </Button>
      </div>
    </Dialog>
  );
}
