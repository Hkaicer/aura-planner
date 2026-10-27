import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AiStatus, ChatStreamEvent } from "../shared/api";
import { createApp, type AppHandle } from "../server/app";
import type { AIProvider } from "../server/ai/providers/types";
import { loadConfig } from "../server/config";
import { DbStore } from "../server/db/store";
import { addFeed, findCalendarLink, hideCalendarLinks, listFeeds, removeFeed, syncFeed } from "../server/services/calendarFeeds";
import { clockAt, memoryDb, TZ } from "./helpers";

const clock = clockAt("2026-10-27T10:00");
const LINK = "https://school.example/calendar/ical/0123abcd";

const vevent = (uid: string, summary: string, start: string, end: string) =>
  ["BEGIN:VEVENT", `UID:${uid}`, `SUMMARY:${summary}`, `DTSTART;TZID=Europe/Paris:${start}`, `DTEND;TZID=Europe/Paris:${end}`, "LOCATION:Room 1", "END:VEVENT"];
const calendar = (...events: string[][]) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//TEST", ...events.flat(), "END:VCALENDAR"].join("\r\n");

const week1 = calendar(
  vevent("a", "Networks", "20261028T083000", "20261028T100000"),
  vevent("b", "Crypto", "20261029T101500", "20261029T114500"),
  vevent("c", "Old lecture", "20261005T083000", "20261005T100000"),
);

const feedEvents = (db: ReturnType<typeof memoryDb>) => new DbStore(db).all("event").filter((e) => e.feedId);

describe("calendar links", () => {
  it("finds calendar links in a message and hides them", () => {
    expect(findCalendarLink(`Add my timetable ${LINK}.`)).toBe(LINK);
    expect(findCalendarLink("webcal://p01-caldav.icloud.com/published/2/xyz")).toBe("webcal://p01-caldav.icloud.com/published/2/xyz");
    expect(findCalendarLink("https://calendar.google.com/calendar/ical/me/private-1/basic.ics")).toContain("basic.ics");
    expect(findCalendarLink("Read https://example.com/article please")).toBeNull();
    expect(hideCalendarLinks(`Add ${LINK}, thanks`, "[calendar link]")).toBe("Add [calendar link], thanks");
  });

  it("adds a calendar, then follows its changes with the same events", async () => {
    const db = memoryDb();
    let text = week1;
    const fetcher = async () => text;

    const first = await addFeed(db, LINK, fetcher, clock);
    expect(first).toMatchObject({ created: true, added: 3, updated: 0, removed: 0, upcoming: 2 });
    expect(first.feed).toMatchObject({ name: "school.example", host: "school.example", eventCount: 3, lastError: null });
    const networks = feedEvents(db).find((e) => e.title === "Networks")!;
    expect(networks).toMatchObject({ date: "2026-10-28", start: "08:30", end: "10:00", location: "Room 1", source: "ics", kind: "commitment" });

    // The school moves one lecture, cancels another and adds a new one.
    text = calendar(
      vevent("a", "Networks", "20261028T133000", "20261028T150000"),
      vevent("c", "Old lecture", "20261005T083000", "20261005T100000"),
      vevent("d", "Law", "20261030T090000", "20261030T120000"),
    );
    const again = await addFeed(db, LINK, fetcher, clock);
    expect(again).toMatchObject({ created: false, added: 1, updated: 1, removed: 1 });
    const moved = feedEvents(db).find((e) => e.title === "Networks")!;
    expect(moved.id).toBe(networks.id);
    expect(moved.start).toBe("13:30");
    expect(feedEvents(db).map((e) => e.title).sort()).toEqual(["Law", "Networks", "Old lecture"]);
    expect(listFeeds(db)).toHaveLength(1);
  });

  it("keeps the events when an update fails, and removes them with the calendar", async () => {
    const db = memoryDb();
    const { feed } = await addFeed(db, LINK, async () => week1, clock);
    await expect(syncFeed(db, feed.id, async () => "<html>Sign in</html>", clock)).rejects.toThrow("does not lead to a calendar");
    expect(feedEvents(db)).toHaveLength(3);
    expect(listFeeds(db)[0]!.lastError).toContain("does not lead to a calendar");

    expect(removeFeed(db, feed.id)).toEqual({ removed: 3 });
    expect(feedEvents(db)).toHaveLength(0);
    expect(listFeeds(db)).toHaveLength(0);
  });

  it("adds a link pasted in the chat without the AI, and keeps the link out of the conversation", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-test-"));
    let asked = 0;
    const ai: AIProvider = {
      id: "claude_code",
      billing: "subscription",
      async status() {
        return { provider: "claude_code", state: "ready", billing: "subscription", message: "", detail: {}, models: [], efforts: [], effortSupported: false, lastModel: null, rateLimit: null, apiKeyConfigured: false, apiConsent: false, apiService: null, chatgpt: null, checkedAt: "" } satisfies AiStatus;
      },
      async run() {
        asked++;
        return { text: "", model: "sonnet", effortApplied: false, usage: null };
      },
    };
    let h: AppHandle | null = null;
    try {
      h = await createApp({
        config: { ...loadConfig(), dataDir, webDir: path.join(dataDir, "no-web") },
        clock,
        providers: { claude_code: ai, anthropic_api: { ...ai, id: "anthropic_api", billing: "api" } },
        fetchCalendar: async (url) => {
          expect(url).toBe(LINK);
          return week1;
        },
      });
      await h.app.inject({ method: "PATCH", url: "/api/settings", payload: { timeZone: TZ, language: "fr" } });
      const res = await h.app.inject({ method: "POST", url: "/api/ai/chat", payload: { message: `Ajoute mon emploi du temps ${LINK}` } });
      const events = res.body.trim().split("\n").map((l) => JSON.parse(l) as ChatStreamEvent);
      expect(events.map((e) => e.type)).toEqual(["accepted", "done"]);
      const done = events[1] as Extract<ChatStreamEvent, { type: "done" }>;
      expect(done.message.meta).toMatchObject({ local: true, status: "ok" });
      expect(done.message.content).toContain("3 événements, dont 2 à venir");
      expect(asked).toBe(0);

      const conversation = (await h.app.inject({ method: "GET", url: "/api/ai/conversation" })).json() as { messages: { content: string }[] };
      expect(conversation.messages.map((m) => m.content).join("\n")).not.toContain("0123abcd");
      expect(conversation.messages[0]!.content).toBe("Ajoute mon emploi du temps [lien du calendrier]");
      const feeds = (await h.app.inject({ method: "GET", url: "/api/calendars" })).json() as { host: string }[];
      expect(feeds).toHaveLength(1);
      expect(JSON.stringify(feeds)).not.toContain("0123abcd");
    } finally {
      if (h) {
        await h.app.close();
        h.db.close();
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
