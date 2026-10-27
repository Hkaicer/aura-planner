// Calendars added by link (iCal or webcal links, such as a school timetable).
// AURA downloads the calendar from its own server and keeps its events up to
// date. No AI is involved, and the link (which holds a private key) is never
// sent to one.

import type { CalendarFeed, CalendarSyncResult } from "../../shared/api";
import type { CalEvent } from "../../shared/schemas";
import { zonedNow } from "../../shared/time";
import type { Database, Row } from "../db/database";
import { DbStore } from "../db/store";
import { DomainError, newId } from "../domain/context";
import { parseIcs, type ParsedIcsEvent } from "./ics";
import { loadSettings } from "./settings";

/** Downloads a calendar file (tests pass their own). */
export type CalendarFetcher = (url: string) => Promise<string>;

/** How old a calendar may get before it is downloaded again. */
export const FEED_REFRESH_MS = 6 * 60 * 60_000;

const MAX_SIZE = 5_000_000;

export const fetchCalendar: CalendarFetcher = async (url) => {
  const res = await fetch(url, { headers: { accept: "text/calendar, text/plain, */*" }, redirect: "follow", signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`The calendar server answered ${res.status}.`);
  return res.text();
};

const LINK = /\b(?:https?|webcal):\/\/[^\s<>"']+/gi;
const looksLikeCalendar = (url: string) => /^webcal:/i.test(url) || /\.ics(?:[?#]|$)|ical|calendar/i.test(url);
const trimLink = (url: string) => url.replace(/[),.;:!?]+$/, "");

/** The first link in a message that looks like a calendar subscription, if any. */
export function findCalendarLink(text: string): string | null {
  for (const m of text.match(LINK) ?? []) {
    const url = trimLink(m);
    if (looksLikeCalendar(url)) return url;
  }
  return null;
}

/** The message with its calendar links replaced, so the private key never reaches the conversation history. */
export function hideCalendarLinks(text: string, label: string): string {
  return text.replace(LINK, (m) => {
    const url = trimLink(m);
    return looksLikeCalendar(url) ? label + m.slice(url.length) : m;
  });
}

function normalizeUrl(raw: string): string {
  const text = raw.trim().replace(/^webcal:\/\//i, "https://");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new DomainError("validation", "This is not a valid link.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new DomainError("validation", "Calendar links start with https:// or webcal://.");
  return url.toString();
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

function rowToFeed(r: Row): CalendarFeed {
  const url = String(r.url);
  return {
    id: String(r.id),
    name: String(r.name),
    host: hostOf(url),
    lastSyncAt: r.last_sync_at === null ? null : String(r.last_sync_at),
    lastError: r.last_error === null ? null : String(r.last_error),
    eventCount: Number(r.event_count),
    createdAt: String(r.created_at),
  };
}

export function listFeeds(db: Database): CalendarFeed[] {
  return db.all("SELECT * FROM calendar_feeds ORDER BY created_at").map(rowToFeed);
}

function feedRow(db: Database, id: string): Row {
  const r = db.get("SELECT * FROM calendar_feeds WHERE id = ?", id);
  if (!r) throw new DomainError("not_found", "This calendar is no longer in AURA.");
  return r;
}

async function download(url: string, fetcher: CalendarFetcher): Promise<string> {
  let text: string;
  try {
    text = await fetcher(url);
  } catch (err) {
    throw new DomainError("invalid_state", `The calendar could not be downloaded: ${(err as Error).message.slice(0, 160)}`);
  }
  if (text.length > MAX_SIZE) throw new DomainError("validation", "This calendar is too large (5 MB max).");
  if (!/BEGIN:VCALENDAR/.test(text)) throw new DomainError("validation", "This link does not lead to a calendar file (iCal). Use the calendar's iCal or subscription link.");
  return text;
}

/** Make the feed's events match the downloaded calendar: same ids for the same events, so nothing else breaks. */
function applyEvents(db: Database, feedId: string, parsed: ParsedIcsEvent[], now: string) {
  const store = new DbStore(db);
  const existing = new Map(store.all("event").filter((e) => e.feedId === feedId).map((e) => [e.feedUid ?? "", e]));
  // A recurring event can repeat its UID for moved occurrences: those are told apart by their date and time.
  const uidCount = new Map<string, number>();
  for (const p of parsed) uidCount.set(p.uid, (uidCount.get(p.uid) ?? 0) + 1);
  let added = 0;
  let updated = 0;
  for (const p of parsed) {
    const key = (uidCount.get(p.uid) ?? 0) > 1 ? `${p.uid}|${p.date}T${p.start}` : p.uid;
    const fields = { title: p.title, date: p.date, start: p.start, end: p.end, allDay: p.allDay, location: p.location, notes: p.notes, recurrence: p.recurrence };
    const old = existing.get(key);
    if (old) {
      existing.delete(key);
      const same = (Object.keys(fields) as (keyof typeof fields)[]).every((k) => JSON.stringify(old[k]) === JSON.stringify(fields[k]));
      if (same) continue;
      store.put("event", { ...old, ...fields, updatedAt: now, rev: old.rev + 1 });
      updated++;
    } else {
      const event: CalEvent = {
        id: newId("e"),
        ...fields,
        kind: "commitment",
        source: "ics",
        isDemo: false,
        feedId,
        feedUid: key,
        createdAt: now,
        updatedAt: now,
        rev: 1,
      };
      store.put("event", event);
      added++;
    }
  }
  for (const gone of existing.values()) store.remove("event", gone.id);
  return { added, updated, removed: existing.size };
}

function synced(db: Database, feedId: string, parsed: ParsedIcsEvent[], now: Date, created: boolean): CalendarSyncResult {
  const counts = db.tx(() => {
    const c = applyEvents(db, feedId, parsed, now.toISOString());
    db.run("UPDATE calendar_feeds SET last_sync_at = ?, last_error = NULL, event_count = ? WHERE id = ?", now.toISOString(), parsed.length, feedId);
    return c;
  });
  const today = zonedNow(loadSettings(db).timeZone, now).date;
  return { feed: rowToFeed(feedRow(db, feedId)), ...counts, upcoming: parsed.filter((p) => p.date >= today || p.recurrence !== null).length, created };
}

function parse(db: Database, text: string): ParsedIcsEvent[] {
  const { events } = parseIcs(text, loadSettings(db).timeZone);
  if (events.length === 0) throw new DomainError("validation", "This calendar has no events.");
  return events;
}

/** Add a calendar by its link and download its events (a link already added is simply refreshed). */
export async function addFeed(db: Database, rawUrl: string, fetcher: CalendarFetcher, clock: () => Date): Promise<CalendarSyncResult> {
  const url = normalizeUrl(rawUrl);
  const known = db.get("SELECT id FROM calendar_feeds WHERE url = ?", url);
  if (known) return syncFeed(db, String(known.id), fetcher, clock);
  const text = await download(url, fetcher);
  const parsed = parse(db, text);
  const name = text.match(/^X-WR-CALNAME:(.+)$/m)?.[1]?.trim().slice(0, 80) || hostOf(url);
  const id = newId("cal");
  db.run("INSERT INTO calendar_feeds (id, name, url, created_at) VALUES (?, ?, ?, ?)", id, name, url, clock().toISOString());
  return synced(db, id, parsed, clock(), true);
}

/** Download a calendar again. On failure its events stay as they were and the error is kept for Settings. */
export async function syncFeed(db: Database, id: string, fetcher: CalendarFetcher, clock: () => Date): Promise<CalendarSyncResult> {
  const url = String(feedRow(db, id).url);
  try {
    const parsed = parse(db, await download(url, fetcher));
    return synced(db, id, parsed, clock(), false);
  } catch (err) {
    db.run("UPDATE calendar_feeds SET last_sync_at = ?, last_error = ? WHERE id = ?", clock().toISOString(), (err as Error).message.slice(0, 300), id);
    throw err;
  }
}

/** Download again the calendars older than FEED_REFRESH_MS. Returns how many changed. */
export async function refreshDueFeeds(db: Database, fetcher: CalendarFetcher, clock: () => Date): Promise<number> {
  let changed = 0;
  for (const feed of listFeeds(db)) {
    if (feed.lastSyncAt && clock().getTime() - Date.parse(feed.lastSyncAt) < FEED_REFRESH_MS) continue;
    try {
      const r = await syncFeed(db, feed.id, fetcher, clock);
      if (r.added + r.updated + r.removed > 0) changed++;
    } catch {
      // Kept in last_error and shown in Settings.
    }
  }
  return changed;
}

/** Remove a calendar and every event that came from it. */
export function removeFeed(db: Database, id: string): { removed: number } {
  feedRow(db, id);
  return db.tx(() => {
    const removed = Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE feed_id = ?", id)?.n ?? 0);
    db.run("DELETE FROM events WHERE feed_id = ?", id);
    db.run("DELETE FROM calendar_feeds WHERE id = ?", id);
    return { removed };
  });
}
