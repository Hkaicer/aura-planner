// Minimal iCalendar (RFC 5545) import/export for events and scheduled tasks.

import type { CalEvent, Recurrence, Task } from "../../shared/schemas";
import { addDays, fromMinutes, instantToZoned, toMinutes, zonedToInstant } from "../../shared/time";

function escapeText(s: string) {
  return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function unescapeText(s: string) {
  return s.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (rest.length > 74) {
    out.push(rest.slice(0, 74));
    rest = " " + rest.slice(74);
  }
  out.push(rest);
  return out.join("\r\n");
}

function utcStamp(d: Date) {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function wallToUtc(date: string, time: string, tz: string) {
  return utcStamp(zonedToInstant(`${date}T${time}`, tz));
}

const DAY_CODES = ["", "MO", "TU", "WE", "TH", "FR", "SA", "SU"];

function rrule(r: Recurrence): string {
  const parts = [`FREQ=${r.freq.toUpperCase()}`];
  if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
  if (r.freq === "weekly" && r.byWeekday?.length) parts.push(`BYDAY=${r.byWeekday.map((d) => DAY_CODES[d]).join(",")}`);
  if (r.until) parts.push(`UNTIL=${r.until.replace(/-/g, "")}T235959Z`);
  return parts.join(";");
}

export function exportIcs(events: CalEvent[], tasks: Task[], tz: string): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//AURA//Personal Planner//EN", "CALSCALE:GREGORIAN"];
  const stamp = utcStamp(new Date());
  for (const e of events) {
    lines.push("BEGIN:VEVENT", `UID:${e.id}@aura.local`, `DTSTAMP:${stamp}`);
    if (e.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${e.date.replace(/-/g, "")}`, `DTEND;VALUE=DATE:${addDays(e.date, 1).replace(/-/g, "")}`);
    } else {
      lines.push(`DTSTART:${wallToUtc(e.date, e.start, tz)}`, `DTEND:${wallToUtc(e.date, e.end, tz)}`);
    }
    lines.push(`SUMMARY:${escapeText(e.title)}`);
    if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);
    if (e.notes) lines.push(`DESCRIPTION:${escapeText(e.notes)}`);
    if (e.recurrence) {
      lines.push(`RRULE:${rrule(e.recurrence)}`);
      for (const ex of e.recurrence.exDates ?? []) lines.push(`EXDATE:${wallToUtc(ex, e.start, tz)}`);
    }
    lines.push(`CATEGORIES:${e.kind.toUpperCase()}`, "END:VEVENT");
  }
  for (const t of tasks) {
    if (!t.scheduledStart || !t.scheduledEnd) continue;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${t.id}@aura.local`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${utcStamp(zonedToInstant(t.scheduledStart, tz))}`,
      `DTEND:${utcStamp(zonedToInstant(t.scheduledEnd, tz))}`,
      `SUMMARY:${escapeText(t.title)}`,
      ...(t.description ? [`DESCRIPTION:${escapeText(t.description)}`] : []),
      `CATEGORIES:TASK,${t.priority.toUpperCase()}`,
      `STATUS:${t.status === "done" ? "CONFIRMED" : "TENTATIVE"}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

export interface ParsedIcsEvent {
  uid: string;
  title: string;
  date: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  notes: string;
  recurrence: Recurrence | null;
}

function unfold(text: string): string[] {
  return text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
}

/** Parse a DTSTART/DTEND value into local wall-clock date and time. */
function parseDate(value: string, params: Record<string, string>, tz: string): { date: string; time: string; allDay: boolean } | null {
  if (params.VALUE === "DATE" || /^\d{8}$/.test(value)) {
    const m = value.match(/^(\d{4})(\d{2})(\d{2})/);
    if (!m) return null;
    return { date: `${m[1]}-${m[2]}-${m[3]}`, time: "00:00", allDay: true };
  }
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) return null;
  const wall = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
  let local: string;
  if (m[7] === "Z") {
    local = instantToZoned(new Date(`${wall}:00Z`), tz);
  } else if (params.TZID) {
    try {
      local = instantToZoned(zonedToInstant(wall, params.TZID), tz);
    } catch {
      local = wall;
    }
  } else local = wall;
  return { date: local.slice(0, 10), time: local.slice(11, 16), allDay: false };
}

function parseRrule(value: string, startDate: string): Recurrence | null {
  const parts = Object.fromEntries(value.split(";").map((p) => p.split("=") as [string, string]));
  const freq = (parts.FREQ ?? "").toLowerCase();
  if (freq !== "daily" && freq !== "weekly" && freq !== "monthly") return null;
  // Rules AURA cannot represent ("second Tuesday", set positions, month days) import as one event.
  if (parts.BYSETPOS || parts.BYMONTHDAY || parts.BYMONTH || /[+-]?\d/.test(parts.BYDAY ?? "") || (freq === "monthly" && parts.BYDAY)) return null;
  const byWeekday = parts.BYDAY
    ? parts.BYDAY.split(",")
        .map((d) => DAY_CODES.indexOf(d.replace(/^[+-]?\d+/, "")))
        .filter((d) => d > 0)
    : undefined;
  let until: string | null = null;
  if (parts.UNTIL) {
    const m = parts.UNTIL.match(/^(\d{4})(\d{2})(\d{2})/);
    if (m) until = `${m[1]}-${m[2]}-${m[3]}`;
  } else if (parts.COUNT) {
    const count = Number(parts.COUNT);
    const interval = Number(parts.INTERVAL ?? 1);
    const span = freq === "daily" ? count * interval : freq === "weekly" ? count * 7 * interval : count * 31 * interval;
    until = addDays(startDate, Math.max(0, span - 1));
  }
  return { freq, interval: Number(parts.INTERVAL ?? 1) || 1, ...(byWeekday?.length ? { byWeekday } : {}), until, exDates: [] };
}

export function parseIcs(text: string, tz: string): { events: ParsedIcsEvent[]; skipped: number } {
  const lines = unfold(text);
  const events: ParsedIcsEvent[] = [];
  let skipped = 0;
  let cur: Record<string, { value: string; params: Record<string, string> }[]> | null = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line === "BEGIN:VEVENT") {
      cur = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (cur) {
        const get = (k: string) => cur![k]?.[0];
        const dtstart = get("DTSTART");
        const s = dtstart ? parseDate(dtstart.value, dtstart.params, tz) : null;
        if (!s) {
          skipped++;
        } else {
          const dtend = get("DTEND");
          const e = dtend ? parseDate(dtend.value, dtend.params, tz) : null;
          let end: string;
          if (s.allDay) end = "23:59";
          else if (e && !e.allDay && e.date === s.date && e.time > s.time) end = e.time;
          else if (e && e.date > s.date) end = "23:59"; // multi-day: clamp to the first day
          else end = fromMinutes(Math.min(toMinutes(s.time) + 60, 23 * 60 + 59)); // no end: assume one hour
          const rr = get("RRULE");
          const exdates = (cur.EXDATE ?? []).flatMap((x) => x.value.split(",").map((v) => parseDate(v, x.params, tz)?.date)).filter((d): d is string => Boolean(d));
          const recurrence = rr ? parseRrule(rr.value, s.date) : null;
          if (recurrence) recurrence.exDates = exdates;
          events.push({
            uid: get("UID")?.value ?? `${s.date}-${s.time}-${get("SUMMARY")?.value ?? ""}`,
            title: unescapeText(get("SUMMARY")?.value ?? "Untitled event").slice(0, 200) || "Untitled event",
            date: s.date,
            start: s.allDay ? "00:00" : s.time,
            end: s.allDay ? "23:59" : end,
            allDay: s.allDay,
            location: unescapeText(get("LOCATION")?.value ?? "").slice(0, 200),
            notes: unescapeText(get("DESCRIPTION")?.value ?? "").slice(0, 4000),
            recurrence: rr && !recurrence ? null : recurrence,
          });
        }
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const head = line.slice(0, idx);
    const value = line.slice(idx + 1);
    const [name, ...paramParts] = head.split(";");
    const params: Record<string, string> = {};
    for (const p of paramParts) {
      const [k, v] = p.split("=");
      if (k && v) params[k.toUpperCase()] = v.replace(/^"|"$/g, "");
    }
    const key = name!.toUpperCase();
    (cur[key] ??= []).push({ value, params });
  }
  return { events, skipped };
}
