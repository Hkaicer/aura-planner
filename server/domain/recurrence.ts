import type { Recurrence } from "../../shared/schemas";
import { diffDays, isoWeekday, startOfWeek } from "../../shared/time";

/** True when a recurrence anchored on `anchor` has an occurrence on `date`. */
export function occursOn(rule: Recurrence, anchor: string, date: string): boolean {
  if (date < anchor) return false;
  if (rule.until && date > rule.until) return false;
  if (rule.exDates?.includes(date)) return false;
  const interval = Math.max(1, rule.interval ?? 1);
  switch (rule.freq) {
    case "daily":
      return diffDays(date, anchor) % interval === 0;
    case "weekly": {
      const days = rule.byWeekday && rule.byWeekday.length > 0 ? rule.byWeekday : [isoWeekday(anchor)];
      if (!days.includes(isoWeekday(date))) return false;
      const weeks = Math.round(diffDays(startOfWeek(date), startOfWeek(anchor)) / 7);
      return weeks % interval === 0;
    }
    case "monthly": {
      if (date.slice(8, 10) !== anchor.slice(8, 10)) return false;
      const months =
        (Number(date.slice(0, 4)) - Number(anchor.slice(0, 4))) * 12 + (Number(date.slice(5, 7)) - Number(anchor.slice(5, 7)));
      return months % interval === 0;
    }
  }
  return false;
}

export function describeRecurrence(rule: Recurrence): string {
  const every = rule.interval > 1 ? `every ${rule.interval} ` : "every ";
  if (rule.freq === "daily") return rule.interval > 1 ? `${every}days` : "daily";
  if (rule.freq === "monthly") return rule.interval > 1 ? `${every}months` : "monthly";
  const names = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const days = (rule.byWeekday ?? []).map((d) => names[d]).join(", ");
  return `${rule.interval > 1 ? every + "weeks" : "weekly"}${days ? ` on ${days}` : ""}`;
}
