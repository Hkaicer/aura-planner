import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { addDays, timeOf } from "@shared/time";
import { api } from "../lib/api";
import { relativeDay } from "../lib/format";
import { useLang, useT } from "../lib/i18n";
import { useAction, useNow } from "../lib/queries";
import { useUi } from "../lib/store";
import { Button, Dialog, Field, Switch } from "./ui";

/** Pick a day (and optionally a time) for a task. */
export function ScheduleDialogHost() {
  const ui = useUi();
  const s = ui.scheduling;
  const task = useQuery({ queryKey: ["task", s?.taskId], queryFn: () => api.task(s!.taskId), enabled: Boolean(s) });
  if (!s || !task.data) return null;
  return <ScheduleDialog key={task.data.id} mode={s.mode} taskId={task.data.id} title={task.data.title} plannedDate={task.data.plannedDate} start={task.data.scheduledStart ? timeOf(task.data.scheduledStart) : ""} onClose={() => ui.set({ scheduling: null })} />;
}

function ScheduleDialog({ mode, taskId, title, plannedDate, start, onClose }: { mode: "schedule" | "move"; taskId: string; title: string; plannedDate: string | null; start: string; onClose: () => void }) {
  const t = useT();
  const lang = useLang();
  const now = useNow();
  const run = useAction();
  const [date, setDate] = useState(plannedDate ?? now.date);
  const [time, setTime] = useState(mode === "schedule" ? start || "" : "");
  const [pin, setPin] = useState(true);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (mode === "schedule" && !time) {
      const next = Math.ceil((now.minutes + 15) / 15) * 15;
      setTime(`${String(Math.min(23, Math.floor(next / 60))).padStart(2, "0")}:${String(next % 60).padStart(2, "0")}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const quick = [0, 1, 2, 7].map((n) => addDays(now.date, n));
  const save = async () => {
    setSaving(true);
    const res = time
      ? await run(() => api.scheduleTask(taskId, date, time, pin), { success: t("toast.scheduled", { time }), undoLabel: t("common.undo") })
      : await run(() => api.moveTask(taskId, date), { success: t("toast.moved", { when: relativeDay(date, now.date, lang, t).toLowerCase() }), undoLabel: t("common.undo") });
    setSaving(false);
    if (res) onClose();
  };
  return (
    <Dialog open onClose={onClose} size="sm" title={mode === "schedule" ? t("action.schedule").replace("…", "") : t("action.moveTo").replace("…", "")} labelledBy="schedule-title">
      <div className="dialog-body">
        <div className="faint truncate">{title}</div>
        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          {quick.map((d) => (
            <button key={d} type="button" className={`chip ${d === date ? "chip-active" : ""}`} onClick={() => setDate(d)}>
              {relativeDay(d, now.date, lang, t)}
            </button>
          ))}
        </div>
        <div className="field-row">
          <Field label={t("task.plannedDate")}>
            <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} data-autofocus />
          </Field>
          <Field label={t("task.start")} hint={!time ? t("task.flexible") : undefined}>
            <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} step={300} />
          </Field>
        </div>
        {time && (
          <label className="checkbox-line" style={{ alignItems: "center" }}>
            <Switch checked={pin} onChange={setPin} label={t("task.pinned")} />
            {t("task.pinned")}
          </label>
        )}
      </div>
      <div className="dialog-footer">
        <Button variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" onClick={() => void save()} loading={saving} disabled={!date}>
          {t("common.save")}
        </Button>
      </div>
    </Dialog>
  );
}
