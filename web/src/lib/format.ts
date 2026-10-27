import type { Task } from "@shared/schemas";
import { addDays, dateOf, diffDays, diffMinutes, formatDuration, timeOf } from "@shared/time";
import { locale, type Lang, type T } from "./i18n";

function asDate(date: string) {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d, 12));
}

export function fmtDate(date: string, lang: Lang, opts: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat(locale(lang), { timeZone: "UTC", ...opts }).format(asDate(date));
}

/** "Sunday 25 October" */
export const longDay = (date: string, lang: Lang) => fmtDate(date, lang, { weekday: "long", day: "numeric", month: "long" });

/** "Mon 26 Oct" */
export const shortDay = (date: string, lang: Lang) => fmtDate(date, lang, { weekday: "short", day: "numeric", month: "short" });

export const weekdayName = (date: string, lang: Lang) => fmtDate(date, lang, { weekday: "long" });

/** Today / Tomorrow / Yesterday / weekday within a week / short date. */
export function relativeDay(date: string, today: string, lang: Lang, t: T): string {
  const d = diffDays(date, today);
  if (d === 0) return t("common.today");
  if (d === 1) return t("common.tomorrow");
  if (d === -1) return t("common.yesterday");
  if (d > 1 && d < 7) return weekdayName(date, lang);
  return shortDay(date, lang);
}

export const duration = (minutes: number) => formatDuration(minutes);

export function timeRange(t: Pick<Task, "scheduledStart" | "scheduledEnd">): string | null {
  if (!t.scheduledStart) return null;
  return `${timeOf(t.scheduledStart)}–${t.scheduledEnd ? timeOf(t.scheduledEnd) : ""}`;
}

export function deadlineLabel(dueAt: string, now: string, today: string, lang: Lang, t: T): { text: string; tone: "danger" | "warning" | "neutral" } {
  const minutes = diffMinutes(now, dueAt);
  const day = dateOf(dueAt);
  if (minutes < 0) {
    const late = -minutes;
    const when = late < 60 * 24 ? formatDuration(late) : relativeDay(day, today, lang, t);
    return { text: t("state.overdueBy", { when }), tone: "danger" };
  }
  if (day === today) return { text: `${t("state.dueToday")} ${timeOf(dueAt) === "23:59" ? "" : timeOf(dueAt)}`.trim(), tone: "warning" };
  const days = diffDays(day, today);
  const when = relativeDay(day, today, lang, t).toLowerCase();
  return { text: t("state.dueIn", { when: lang === "fr" ? when : when }), tone: days <= 2 ? "warning" : "neutral" };
}

export function greetingKey(minutes: number): "greeting.morning" | "greeting.afternoon" | "greeting.evening" | "greeting.night" {
  if (minutes < 5 * 60) return "greeting.night";
  if (minutes < 12 * 60) return "greeting.morning";
  if (minutes < 18 * 60) return "greeting.afternoon";
  if (minutes < 23 * 60) return "greeting.evening";
  return "greeting.night";
}

export function weekDates(anchor: string): string[] {
  const [y, m, d] = anchor.split("-").map(Number) as [number, number, number];
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
  const monday = addDays(anchor, 1 - wd);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

export function relativeTime(iso: string, lang: Lang): string {
  const diff = Date.now() - Date.parse(iso);
  const rtf = new Intl.RelativeTimeFormat(locale(lang), { numeric: "auto" });
  const mins = Math.round(diff / 60000);
  if (Math.abs(mins) < 1) return rtf.format(0, "minute");
  if (Math.abs(mins) < 60) return rtf.format(-mins, "minute");
  const hours = Math.round(mins / 60);
  if (Math.abs(hours) < 24) return rtf.format(-hours, "hour");
  return rtf.format(-Math.round(hours / 24), "day");
}

export function modelLabel(model: string | null | undefined): string {
  if (!model) return "Claude";
  // DeepSeek: "deepseek-v4-pro" → "DeepSeek V4 Pro".
  if (model.startsWith("deepseek-")) {
    return ["DeepSeek", ...model.slice(9).split("-").map((p) => (/^v\d/.test(p) ? p.toUpperCase() : p[0]!.toUpperCase() + p.slice(1)))].join(" ");
  }
  // ChatGPT: "gpt-6.1-sol" → "GPT-6.1 Sol".
  if (model.startsWith("gpt-")) {
    const [version, ...rest] = model.slice(4).split("-");
    return [`GPT-${version}`, ...rest.map((p) => p[0]!.toUpperCase() + p.slice(1))].join(" ");
  }
  const m = model.match(/claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/);
  if (!m) return model === "sonnet" ? "Sonnet" : model === "opus" ? "Opus" : model === "haiku" ? "Haiku" : model;
  const name = m[1]![0]!.toUpperCase() + m[1]!.slice(1);
  return `${name} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}
