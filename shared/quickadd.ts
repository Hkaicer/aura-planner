// Deterministic natural-language parser for quick capture (no AI involved).
// Understands English and French shorthand, e.g.
//   "Call mom tomorrow 18:00 30m !high #family +Personal"
//   "Rapport de labo demain 14h 1h30 !critique avant vendredi"

import type { Priority } from "./schemas";
import { addDays, isoWeekday } from "./time";

export interface QuickParse {
  title: string;
  plannedDate: string | null;
  start: string | null;
  estimateMin: number | null;
  priority: Priority | null;
  tags: string[];
  project: string | null;
  dueDate: string | null;
  tokens: { kind: "date" | "time" | "duration" | "priority" | "tag" | "project" | "due"; text: string }[];
}

const WEEKDAYS: Record<string, number> = {
  mon: 1, monday: 1, lun: 1, lundi: 1,
  tue: 2, tues: 2, tuesday: 2, mar: 2, mardi: 2,
  wed: 3, wednesday: 3, mer: 3, mercredi: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, jeu: 4, jeudi: 4,
  fri: 5, friday: 5, ven: 5, vendredi: 5,
  sat: 6, saturday: 6, sam: 6, samedi: 6,
  sun: 7, sunday: 7, dim: 7, dimanche: 7,
};

const PRIORITY_WORDS: Record<string, Priority> = {
  "!!!": "critical", "!critical": "critical", "!crit": "critical", "!urgent": "critical", "!critique": "critical", "!c": "critical",
  "!!": "high", "!high": "high", "!h": "high", "!haute": "high", "!important": "high",
  "!medium": "medium", "!m": "medium", "!moyenne": "medium", "!normal": "medium",
  "!low": "low", "!l": "low", "!basse": "low", "!": "medium",
};

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function resolveDay(word: string, today: string): string | null {
  const w = word.toLowerCase();
  if (["today", "tod", "aujourd'hui", "aujourdhui", "auj", "tonight", "ce soir"].includes(w)) return today;
  if (["tomorrow", "tmr", "tom", "demain"].includes(w)) return addDays(today, 1);
  if (["après-demain", "apres-demain", "overmorrow"].includes(w)) return addDays(today, 2);
  const wd = WEEKDAYS[w];
  if (wd) {
    const diff = (wd - isoWeekday(today) + 7) % 7;
    return addDays(today, diff);
  }
  return null;
}

function parseExplicitDate(word: string, today: string): string | null {
  let m = word.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = word.match(/^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?$/);
  if (m) {
    const day = Number(m[1]);
    const month = Number(m[2]);
    if (day < 1 || day > 31 || month < 1 || month > 12) return null;
    let year = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : Number(today.slice(0, 4));
    let candidate = `${year}-${pad(month)}-${pad(day)}`;
    if (!m[3] && candidate < today) {
      year++;
      candidate = `${year}-${pad(month)}-${pad(day)}`;
    }
    return candidate;
  }
  return null;
}

export function parseQuickAdd(input: string, today: string): QuickParse {
  const out: QuickParse = { title: "", plannedDate: null, start: null, estimateMin: null, priority: null, tags: [], project: null, dueDate: null, tokens: [] };
  let text = ` ${input.trim()} `;
  const take = (re: RegExp, fn: (m: RegExpMatchArray) => boolean) => {
    text = text.replace(re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpMatchArray;
      return fn(m) ? " " : (args[0] as string);
    });
  };

  // Deadlines: "due friday", "by 30/10", "avant vendredi"
  take(/\s(?:due|by|before|avant|pour)\s+(\S+)(?=\s)/gi, (m) => {
    const d = resolveDay(m[1]!, today) ?? parseExplicitDate(m[1]!, today);
    if (!d || out.dueDate) return false;
    out.dueDate = d;
    out.tokens.push({ kind: "due", text: m[0].trim() });
    return true;
  });

  // Relative days: "in 3 days", "dans 3 jours", "next week", "la semaine prochaine"
  take(/\s(?:in|dans)\s+(\d{1,2})\s+(?:days?|jours?)(?=\s)/gi, (m) => {
    out.plannedDate = addDays(today, Number(m[1]));
    out.tokens.push({ kind: "date", text: m[0].trim() });
    return true;
  });
  take(/\s(?:next week|la semaine prochaine|semaine prochaine)(?=\s)/gi, (m) => {
    out.plannedDate = addDays(today, 8 - isoWeekday(today));
    out.tokens.push({ kind: "date", text: m[0].trim() });
    return true;
  });

  // Durations: 30m, 45min, 2h, 1h30, 1.5h, "for 2 hours", "pendant 1h"
  take(/\s(?:for\s+|pendant\s+)?(\d{1,2})h(\d{2})(?:min)?(?=\s)/gi, (m) => {
    const hours = Number(m[1]);
    const explicit = /^(for|pendant)/i.test(m[0].trim());
    if (!explicit && hours >= 5) return false; // "18h30" is a time, not a duration
    if (out.estimateMin !== null) return false;
    out.estimateMin = hours * 60 + Number(m[2]);
    out.tokens.push({ kind: "duration", text: m[0].trim() });
    return true;
  });
  take(/\s(?:for\s+|pendant\s+)?(\d+(?:[.,]\d+)?)\s?(h|hr|hrs|hours?|heures?|m|min|mins|minutes?)(?=\s)/gi, (m) => {
    const value = Number(m[1]!.replace(",", "."));
    const unit = m[2]!.toLowerCase();
    const isHours = unit.startsWith("h");
    const explicit = /^(for|pendant)/i.test(m[0].trim());
    if (isHours && unit === "h" && !explicit && value >= 5 && Number.isInteger(value)) return false; // "18h" is a time
    if (out.estimateMin !== null) return false;
    const minutes = Math.round(isHours ? value * 60 : value);
    if (minutes < 5 || minutes > 720) return false;
    out.estimateMin = minutes;
    out.tokens.push({ kind: "duration", text: m[0].trim() });
    return true;
  });

  // Times: 18:00, 18h, 18h30, 6pm, 6:30pm, "at 9", "à 14h"
  take(/\s(?:at\s+|à\s+|a\s+)?(\d{1,2})(?::(\d{2}))?\s?(am|pm)(?=\s)/gi, (m) => {
    let h = Number(m[1]);
    const min = Number(m[2] ?? 0);
    if (h < 1 || h > 12 || min > 59) return false;
    if (m[3]!.toLowerCase() === "pm" && h !== 12) h += 12;
    if (m[3]!.toLowerCase() === "am" && h === 12) h = 0;
    out.start = `${pad(h)}:${pad(min)}`;
    out.tokens.push({ kind: "time", text: m[0].trim() });
    return true;
  });
  take(/\s(?:at\s+|à\s+|a\s+)?([01]?\d|2[0-3])(?::|h)([0-5]\d)?(?=\s)/gi, (m) => {
    if (out.start) return false;
    const raw = m[0].trim();
    const hasPrefix = /^(at|à|a)\s/i.test(raw);
    const hasSeparator = /[:h]/i.test(raw.replace(/^(at|à|a)\s+/i, ""));
    if (!hasSeparator && !hasPrefix) return false;
    out.start = `${pad(Number(m[1]))}:${pad(Number(m[2] ?? 0))}`;
    out.tokens.push({ kind: "time", text: raw });
    return true;
  });
  take(/\s(?:at|à)\s+([01]?\d|2[0-3])(?=\s)/gi, (m) => {
    if (out.start) return false;
    out.start = `${pad(Number(m[1]))}:00`;
    out.tokens.push({ kind: "time", text: m[0].trim() });
    return true;
  });

  // Days: today, tomorrow, weekday names, explicit dates
  take(/\s(today|tod|tonight|aujourd'hui|aujourdhui|tomorrow|tmr|demain|après-demain|apres-demain|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)(?=\s)/gi, (m) => {
    if (out.plannedDate) return false;
    const d = resolveDay(m[1]!, today);
    if (!d) return false;
    out.plannedDate = d;
    out.tokens.push({ kind: "date", text: m[0].trim() });
    return true;
  });
  take(/\s(?:on\s+|le\s+)?(\d{4}-\d{2}-\d{2}|\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?)(?=\s)/gi, (m) => {
    if (out.plannedDate) return false;
    const d = parseExplicitDate(m[1]!, today);
    if (!d) return false;
    out.plannedDate = d;
    out.tokens.push({ kind: "date", text: m[0].trim() });
    return true;
  });

  // Priority: !!!, !!, !high, !critique...
  take(/\s(!{1,3}[a-zé]*)(?=\s)/gi, (m) => {
    const p = PRIORITY_WORDS[m[1]!.toLowerCase()];
    if (!p || out.priority) return false;
    out.priority = p;
    out.tokens.push({ kind: "priority", text: m[1]! });
    return true;
  });

  // Tags and project
  take(/\s#([\p{L}\d_-]{1,40})(?=\s)/giu, (m) => {
    out.tags.push(m[1]!);
    out.tokens.push({ kind: "tag", text: `#${m[1]}` });
    return true;
  });
  take(/\s\+(?:"([^"]{1,80})"|([\p{L}\d_-]{1,80}))(?=\s)/giu, (m) => {
    if (out.project) return false;
    out.project = (m[1] ?? m[2])!;
    out.tokens.push({ kind: "project", text: m[0].trim() });
    return true;
  });

  out.title = text.replace(/\s+/g, " ").trim();
  if (out.start && !out.plannedDate) out.plannedDate = today;
  return out;
}
