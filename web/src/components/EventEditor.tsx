import { useQuery } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import type { CalEvent } from "@shared/schemas";
import { isoWeekday } from "@shared/time";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { useAction } from "../lib/queries";
import { useUi } from "../lib/store";
import { Button, confirmAction, Dialog, Field, Spinner, Switch } from "./ui";

export function EventEditorHost() {
  const ui = useUi();
  const e = ui.editingEvent;
  const range = e ? { from: e.date, to: e.date } : null;
  const q = useQuery({
    queryKey: ["events", range?.from, range?.to, e?.id],
    queryFn: () => api.events(range!.from, range!.to),
    enabled: Boolean(e?.id),
  });
  if (!e) return null;
  const close = () => ui.set({ editingEvent: null });
  if (e.id && q.isLoading) {
    return (
      <Dialog open onClose={close} size="sm">
        <div className="dialog-body" style={{ alignItems: "center", padding: 32 }}>
          <Spinner />
        </div>
      </Dialog>
    );
  }
  const existing = e.id ? q.data?.find((x) => x.seriesId === e.id) ?? null : null;
  return <EventEditor key={e.id ?? `${e.date}${e.start}`} initial={existing} date={e.date} start={e.start} end={e.end} occurrence={e.occurrence} onClose={close} />;
}

function EventEditor({ initial, date, start, end, occurrence, onClose }: { initial: CalEvent | null; date: string; start: string; end: string; occurrence?: string; onClose: () => void }) {
  const t = useT();
  const run = useAction();
  const [title, setTitle] = useState(initial?.title ?? "");
  const [d, setD] = useState(initial?.date ?? date);
  const [s, setS] = useState(initial?.start ?? start);
  const [en, setEn] = useState(initial?.end ?? end);
  const [kind, setKind] = useState<CalEvent["kind"]>(initial?.kind ?? "commitment");
  const [location, setLocation] = useState(initial?.location ?? "");
  const [weekly, setWeekly] = useState(Boolean(initial?.recurrence));
  const [saving, setSaving] = useState(false);
  const invalid = !title.trim() || en <= s;

  const save = async () => {
    setSaving(true);
    const recurrence = weekly ? initial?.recurrence ?? { freq: "weekly" as const, interval: 1, byWeekday: [isoWeekday(d)], exDates: [] } : null;
    const body = { title: title.trim(), date: d, start: s, end: en, kind, location, recurrence };
    const res = initial
      ? await run(() => api.updateEvent(initial.id, body), { success: t("toast.saved"), undoLabel: t("common.undo") })
      : await run(() => api.createEvent(body), { success: t("toast.created", { title: body.title }), undoLabel: t("common.undo") });
    setSaving(false);
    if (res) onClose();
  };

  const remove = async () => {
    if (!initial) return;
    let occ: string | undefined;
    if (initial.recurrence) {
      const { ok, option } = await confirmAction({
        title: t("action.deleteConfirm", { title: initial.title }),
        confirmLabel: t("common.delete"),
        cancelLabel: t("common.cancel"),
        danger: true,
        option: { label: t("calendar.deleteSeries"), default: false },
      });
      if (!ok) return;
      occ = option ? undefined : occurrence;
    } else {
      const { ok } = await confirmAction({ title: t("action.deleteConfirm", { title: initial.title }), confirmLabel: t("common.delete"), cancelLabel: t("common.cancel"), danger: true });
      if (!ok) return;
    }
    const res = await run(() => api.deleteEvent(initial.id, occ), { success: t("toast.deleted", { title: initial.title }), undoLabel: t("common.undo") });
    if (res) onClose();
  };

  return (
    <Dialog open onClose={onClose} size="sm" title={initial ? t("calendar.editEvent") : t("calendar.newEvent")} labelledBy="event-title">
      <div className="dialog-body">
        {initial?.feedId && <p className="field-hint">{t("calendars.fromFeed")}</p>}
        <Field label={t("calendar.eventTitle")}>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} data-autofocus />
        </Field>
        <div className="field-row">
          <Field label={t("task.plannedDate")}>
            <input className="input" type="date" value={d} onChange={(e) => setD(e.target.value)} />
          </Field>
          <Field label={t("task.start")}>
            <input className="input" type="time" value={s} onChange={(e) => setS(e.target.value)} step={300} />
          </Field>
          <Field label={t("task.end")}>
            <input className="input" type="time" value={en} onChange={(e) => setEn(e.target.value)} step={300} aria-invalid={en <= s} />
          </Field>
        </div>
        <div className="field-row">
          <Field label={t("calendar.kind")}>
            <select className="select" value={kind} onChange={(e) => setKind(e.target.value as CalEvent["kind"])}>
              <option value="commitment">{t("calendar.kind.commitment")}</option>
              <option value="break">{t("calendar.kind.break")}</option>
              <option value="unavailable">{t("calendar.kind.unavailable")}</option>
            </select>
          </Field>
          <Field label={t("calendar.location")}>
            <input className="input" value={location} onChange={(e) => setLocation(e.target.value)} />
          </Field>
        </div>
        <label className="checkbox-line" style={{ alignItems: "center" }}>
          <Switch checked={weekly} onChange={setWeekly} label={t("calendar.repeatWeekly")} />
          {t("calendar.repeatWeekly")}
        </label>
      </div>
      <div className="dialog-footer">
        {initial && (
          <Button variant="danger-ghost" icon={<Trash2 />} onClick={() => void remove()}>
            {t("common.delete")}
          </Button>
        )}
        <span className="spacer" />
        <Button variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" onClick={() => void save()} loading={saving} disabled={invalid}>
          {t("common.save")}
        </Button>
      </div>
    </Dialog>
  );
}
