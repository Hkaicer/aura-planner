import type { ChatMessage, Proposal } from "../../shared/api";
import type { Task } from "../../shared/schemas";
import { addDays, isoWeekday, zonedNow } from "../../shared/time";
import { localNow, type DomainContext } from "../domain/context";
import { eventsBetween, getDayPlan } from "../domain/entities";
import { dayWindow } from "../domain/planning";
import { isOpen, isTemplate } from "../domain/tasks";
import { taskBrief } from "./tools";

const WEEKDAYS = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const SYSTEM_PROMPT = `You are AURA, a calm and competent personal executive assistant inside a local productivity app. You help one person plan and run their days.

How you work:
- You act on the user's real tasks, projects and calendar only through the AURA tools. Never invent tasks, ids or times; read with a tool before changing something you have not seen in the context.
- Every change made with a write tool is staged as a proposal. The app shows it to the user: small changes may apply automatically, larger ones wait for approval. Describe changes as prepared or proposed ("I've prepared...", "Here's the plan..."), never as already done, and do not repeat every detail: the user sees a preview.
- Time placement belongs to the deterministic scheduler: call plan_day instead of computing times yourself. When the user asks for a specific time, use schedule_task (pinned), then plan_day with mode "preserve" so the rest of the day adapts. After a delay ("I lost 90 minutes", "I'm running late", "that took longer"), the lost time is already in the past: call plan_day with mode "reflow" and no blockFromNowMin, so the rest of the day restarts from the current time. Use blockFromNowMin only when the user says they will be unavailable from now on (for example "I have to leave for an hour").
- Fixed commitments the user mentions (class, meeting, appointment, work shift) are events: create_event with kind "commitment". Breaks they explicitly ask for are events with kind "break". Tasks are things to do.
- Respect events, completed tasks, pinned tasks and hard deadlines. If something does not fit, say so plainly, name what does not fit, and suggest a concrete fix (another day, shorter, or drop).
- Estimate durations realistically when not given and mention them briefly. Mark demanding work (studying, writing, deep work) with energy "high".
- Ask a clarifying question (without making changes) only when essential information is missing and no sensible default exists. Otherwise act on reasonable assumptions and state them in one line.
- Resolve "today", "tomorrow" and weekdays with the calendar in the context. Times are 24-hour local wall-clock time.
- To look back (what was completed, what slipped, past reviews), use review_period; past events are available with list_events.
- References like "that task", "it", "the previous one" point to the items most recently discussed (see the conversation and "recently referenced").
- When the user states a lasting preference about how they work, you may save it with remember; it stays visible to them.
- Reply in the user's language (English or French). Be concise: two to six short sentences or a short list. No tables, no headings, no talk about tools or ids.`;

function taskLine(ctx: DomainContext, t: Task): string {
  const b = taskBrief(ctx, t);
  const parts = [
    `${b.id}`,
    `"${b.title}"`,
    b.status,
    b.priority,
    `${b.estimateMin}m`,
    b.plannedDate ? `day ${b.plannedDate}` : "backlog",
    b.start ? `${b.start}-${b.end}${b.pinned ? " pinned" : ""}` : null,
    b.dueAt ? `due ${b.dueAt.replace("T", " ")}${b.dueHard ? "" : " (soft)"}` : null,
    b.project ? `project ${b.project}` : null,
    b.energy ? `energy ${b.energy}` : null,
    b.dependsOn ? `after ${b.dependsOn.join(",")}` : null,
    b.subtasks ? `subtasks ${b.subtasks}` : null,
  ];
  return `- ${parts.filter(Boolean).join(" | ")}`;
}

/**
 * The task context sent with each request ("standard" scope): open tasks planned
 * up to 14 days ahead or due within 14 days (overdue included), plus today's
 * completed tasks. Everything else stays local unless Claude asks for it
 * through a tool.
 */
export function relevantTasks(ctx: DomainContext, today: string): { tasks: Task[]; backlog: number; inbox: number } {
  const horizon = addDays(today, 14);
  const tasks = ctx.store.all("task").filter((t) => !isTemplate(t));
  const open = tasks.filter(
    (t) =>
      isOpen(t) &&
      t.status !== "inbox" &&
      ((t.plannedDate !== null && t.plannedDate <= horizon) || (t.dueAt !== null && t.dueAt.slice(0, 10) <= horizon)),
  );
  const doneToday = tasks.filter(
    (t) => t.status === "done" && (t.plannedDate === today || (t.completedAt !== null && zonedNow(ctx.settings.timeZone, new Date(t.completedAt)).date === today)),
  );
  const rank = (t: Task) => (t.plannedDate === today ? 0 : t.plannedDate && t.plannedDate < today ? 1 : t.plannedDate ? 2 : 3);
  const included = new Set(open.map((t) => t.id));
  const backlog = tasks.filter((t) => isOpen(t) && t.status !== "inbox" && t.plannedDate === null && !included.has(t.id)).length;
  const inbox = tasks.filter((t) => t.status === "inbox").length;
  return {
    tasks: [...open.sort((a, b) => rank(a) - rank(b) || (a.plannedDate ?? "~").localeCompare(b.plannedDate ?? "~")).slice(0, 60), ...doneToday.slice(0, 20)],
    backlog,
    inbox,
  };
}

export function buildContext(ctx: DomainContext, history: ChatMessage[], proposals: Map<string, Proposal>): string {
  const now = localNow(ctx);
  const s = ctx.settings;
  const calendar = Array.from({ length: 14 }, (_, i) => {
    const d = addDays(now.date, i);
    const label = i === 0 ? "today" : i === 1 ? "tomorrow" : "";
    return `${WEEKDAYS[isoWeekday(d)]} ${d}${label ? ` (${label})` : ""}`;
  }).join(", ");

  const lines: string[] = [];
  lines.push(`Now: ${WEEKDAYS[now.weekday]} ${now.date} ${now.time} (${s.timeZone}).`);
  lines.push(`Calendar: ${calendar}.`);
  for (const offset of [0, 1]) {
    const d = addDays(now.date, offset);
    const plan = getDayPlan(ctx, d);
    const w = dayWindow(s, plan, d);
    const hh = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    lines.push(
      `Planning window ${offset === 0 ? "today" : "tomorrow"}: ${hh(w.start)}-${hh(w.end)}${plan.intensity === "light" ? " (light day)" : ""}${w.source === "override" ? " (custom for this day)" : ""}.`,
    );
  }
  lines.push(
    `Preferences: work days ${s.workDays.map((d) => WEEKDAYS[d]).join(",")}; default day ${s.dayStart}-${s.dayEnd}; sleep ${s.sleepStart}-${s.sleepEnd}; focus blocks up to ${s.focusBlockMin}m then ${s.breakMin}m break; ${s.bufferMin}m buffer; lunch ${s.lunch.enabled ? `${s.lunch.durationMin}m between ${s.lunch.earliest}-${s.lunch.latest}` : "off"}; peak energy ${s.peakEnergy}; strategy ${s.strategy}; default estimate ${s.defaultEstimateMin}m.`,
  );
  if (s.displayName) lines.push(`User's name: ${s.displayName}.`);
  lines.push(`Interface language: ${s.language === "fr" ? "French" : "English"} (answer in the language the user writes in).`);
  const memory = ctx.store.all("memory");
  if (memory.length) lines.push(`Saved notes about the user:\n${memory.map((m) => `- ${m.text}`).join("\n")}`);

  const events = eventsBetween(ctx, now.date, addDays(now.date, 6));
  lines.push(
    events.length
      ? `Fixed events (next 7 days):\n${events.map((e) => `- ${e.id} ${e.occurrenceDate} ${e.allDay ? "all day" : `${e.start}-${e.end}`} "${e.title}" (${e.kind})`).join("\n")}`
      : "Fixed events (next 7 days): none.",
  );
  const { tasks, backlog, inbox } = relevantTasks(ctx, now.date);
  lines.push(tasks.length ? `Tasks (next 14 days, overdue, and done today):\n${tasks.map((t) => taskLine(ctx, t)).join("\n")}` : "Tasks in the next 14 days: none.");
  if (backlog || inbox) {
    lines.push(`Not shown: ${backlog} unplanned backlog task(s) and ${inbox} inbox item(s). Use list_tasks to read them; use review_period to look at past days.`);
  }
  const projects = ctx.store.all("project").filter((p) => p.status === "active");
  if (projects.length) lines.push(`Projects: ${projects.map((p) => `${p.id} "${p.name}"${p.deadline ? ` (deadline ${p.deadline})` : ""}`).join("; ")}.`);

  // Items touched recently, so "it" / "that task" can be resolved.
  const referenced: string[] = [];
  for (const m of [...history].reverse()) {
    const p = m.meta.proposalId ? proposals.get(m.meta.proposalId) : undefined;
    if (!p) continue;
    for (const item of p.items) {
      if (item.entity !== "task" && item.entity !== "event") continue;
      const label = `"${item.title}" (${item.key.split(":")[1]})`;
      if (!referenced.includes(label)) referenced.push(label);
    }
    if (referenced.length >= 8) break;
  }
  if (referenced.length) lines.push(`Recently referenced (most recent first): ${referenced.join(", ")}.`);
  return lines.join("\n");
}

function proposalNote(p: Proposal | undefined): string {
  if (!p) return "";
  const what = p.items
    .slice(0, 6)
    .map((i) => `${i.kind} "${i.title}"`)
    .join(", ");
  const status =
    p.status === "applied" || p.status === "auto_applied"
      ? "applied"
      : p.status === "pending"
        ? "awaiting the user's approval"
        : p.status === "discarded"
          ? "discarded by the user"
          : p.status === "undone"
            ? "undone by the user"
            : "failed";
  return ` [Proposed changes ${status}: ${what}${p.items.length > 6 ? ", ..." : ""}]`;
}

export function buildPrompt(
  ctx: DomainContext,
  message: string,
  history: ChatMessage[],
  proposals: Map<string, Proposal>,
  maxTurns: number,
): string {
  const turns = history.filter((m) => m.role !== "system" && m.meta.kind !== "brief").slice(-maxTurns);
  const convo = turns
    .map((m) => {
      if (m.role === "user") return `User: ${m.content}`;
      const content = m.meta.status === "error" ? `(failed: ${m.meta.error?.message ?? "error"})` : m.content;
      return `AURA: ${content.length > 1200 ? `${content.slice(0, 1200)}...` : content}${proposalNote(m.meta.proposalId ? proposals.get(m.meta.proposalId) : undefined)}`;
    })
    .join("\n\n");
  return [
    "<context>",
    buildContext(ctx, history, proposals),
    "</context>",
    convo ? `<conversation>\n${convo}\n</conversation>` : "",
    "<request>",
    message,
    "</request>",
  ]
    .filter(Boolean)
    .join("\n");
}

export const BRIEF_PROMPT = `Write a short overview of the user's day for the top of their dashboard: 2-3 sentences, warm and practical. Mention the shape of the day (commitments, key tasks, deadlines), whether it looks realistic or overloaded, and one concrete suggestion. Use get_day if you need more detail. Do not make any changes. Reply in the user's language.`;
