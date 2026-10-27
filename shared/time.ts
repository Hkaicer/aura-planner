// Wall-clock date/time helpers shared by the server and the web client.
// Dates are "YYYY-MM-DD", times are "HH:mm", date-times are "YYYY-MM-DDTHH:mm",
// all interpreted in the user's configured time zone. Day arithmetic is done on
// UTC-anchored Date objects so that DST transitions never shift a calendar day.

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;

export function isValidDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function isValidDateTime(value: string): boolean {
  return DATETIME_RE.test(value) && isValidDate(value.slice(0, 10));
}

export function toMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number) as [number, number];
  return h * 60 + m;
}

export function fromMinutes(total: number): string {
  const clamped = Math.max(0, Math.min(24 * 60 - 1, Math.round(total)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function dateOf(dateTime: string): string {
  return dateTime.slice(0, 10);
}

export function timeOf(dateTime: string): string {
  return dateTime.slice(11, 16);
}

export function minutesOf(dateTime: string): number {
  return toMinutes(timeOf(dateTime));
}

export function combine(date: string, time: string): string {
  return `${date}T${time}`;
}

export function combineMinutes(date: string, minutes: number): string {
  return `${date}T${fromMinutes(minutes)}`;
}

function parseDateUTC(date: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

function formatDateUTC(dt: Date): string {
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

export function addDays(date: string, days: number): string {
  const dt = parseDateUTC(date);
  dt.setUTCDate(dt.getUTCDate() + days);
  return formatDateUTC(dt);
}

export function diffDays(a: string, b: string): number {
  return Math.round((parseDateUTC(a).getTime() - parseDateUTC(b).getTime()) / 86_400_000);
}

/** ISO weekday: 1 = Monday ... 7 = Sunday. */
export function isoWeekday(date: string): number {
  const d = parseDateUTC(date).getUTCDay();
  return d === 0 ? 7 : d;
}

export function startOfWeek(date: string): string {
  return addDays(date, 1 - isoWeekday(date));
}

export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function compareDateTime(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Minutes between two wall-clock date-times (b - a). */
export function diffMinutes(a: string, b: string): number {
  const days = diffDays(dateOf(b), dateOf(a));
  return days * 1440 + minutesOf(b) - minutesOf(a);
}

export function addMinutesToDateTime(dateTime: string, minutes: number): string {
  let date = dateOf(dateTime);
  let total = minutesOf(dateTime) + minutes;
  while (total < 0) {
    total += 1440;
    date = addDays(date, -1);
  }
  while (total >= 1440) {
    total -= 1440;
    date = addDays(date, 1);
  }
  return combineMinutes(date, total);
}

export interface ZonedNow {
  date: string;
  time: string;
  minutes: number;
  dateTime: string;
  weekday: number;
}

/** Current wall-clock date and time in an IANA time zone. */
export function zonedNow(timeZone: string, at: Date = new Date()): ZonedNow {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const time = `${get("hour") === "24" ? "00" : get("hour")}:${get("minute")}`;
  return { date, time, minutes: toMinutes(time), dateTime: combine(date, time), weekday: isoWeekday(date) };
}

/** Convert a UTC instant to a wall-clock date-time in a time zone. */
export function instantToZoned(at: Date, timeZone: string): string {
  return zonedNow(timeZone, at).dateTime;
}

/** Convert a wall-clock date-time in a time zone to a UTC instant. */
export function zonedToInstant(dateTime: string, timeZone: string): Date {
  const [datePart, timePart] = dateTime.split("T") as [string, string];
  const [y, mo, d] = datePart.split("-").map(Number) as [number, number, number];
  const [h, mi] = timePart.split(":").map(Number) as [number, number];
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  // Two passes handle offsets that differ on either side of a DST change.
  let instant = guess;
  for (let i = 0; i < 2; i++) {
    const shown = instantToZoned(new Date(instant), timeZone);
    const delta = diffMinutes(shown, dateTime);
    instant += delta * 60_000;
  }
  return new Date(instant);
}

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r}m`;
  if (r === 0) return `${h}h`;
  return `${h}h${String(r).padStart(2, "0")}`;
}
