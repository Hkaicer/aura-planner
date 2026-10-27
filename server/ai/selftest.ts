// Safety self-test: feeds malformed and hostile tool calls through the exact
// validation path used for real model output, on a throwaway overlay, and
// checks that every one is rejected and nothing is staged or written.

import type { Settings } from "../../shared/schemas";
import type { Database } from "../db/database";
import { DbStore, OverlayStore } from "../db/store";
import { executeTool, type RunContext } from "./tools";

export interface SelfTestResult {
  passed: boolean;
  stagedChanges: number;
  databaseUnchanged: boolean;
  results: { label: string; tool: string; rejected: boolean; error: string | null }[];
}

function fingerprint(db: Database): string {
  const rows = ["tasks", "projects", "events", "day_plans", "memory"].map((t) => {
    const r = db.get<{ n: number; r: number | null }>(`SELECT COUNT(*) AS n, SUM(rev) AS r FROM ${t === "day_plans" ? t : t}`);
    return `${t}:${r?.n ?? 0}:${r?.r ?? 0}`;
  });
  return rows.join("|");
}

export function runSelfTest(db: Database, settings: Settings, clock: () => Date): SelfTestResult {
  const before = fingerprint(db);
  const overlay = new OverlayStore(new DbStore(db));
  const rc: RunContext = {
    id: "selftest",
    token: "selftest",
    overlay,
    ctx: { store: overlay, settings, clock },
    readOnly: false,
    toolCalls: [],
    plans: [],
    maxToolCalls: 100,
    closed: false,
  };
  const anyTask = overlay.all("task")[0]?.id ?? "t_missing";
  const cases: { label: string; tool: string; input: unknown }[] = [
    { label: "Unknown tool name", tool: "drop_all_tables", input: {} },
    { label: "Missing required field", tool: "create_task", input: {} },
    { label: "Wrong field type", tool: "create_task", input: { title: 42 } },
    { label: "Out-of-range duration", tool: "create_task", input: { title: "Test", estimateMin: -30 } },
    { label: "Invalid priority value", tool: "update_task", input: { id: anyTask, priority: "urgent!!!" } },
    { label: "Impossible date and time", tool: "schedule_task", input: { id: anyTask, date: "2026-02-30", start: "25:61" } },
    { label: "Unknown task id", tool: "complete_task", input: { id: "t_does_not_exist" } },
    { label: "Self-dependency (cycle)", tool: "set_dependency", input: { taskId: anyTask, dependsOnId: anyTask } },
    { label: "Non-object arguments", tool: "plan_day", input: "DROP TABLE tasks; --" },
    { label: "Array instead of object", tool: "move_task", input: [anyTask, "tomorrow"] },
    { label: "Truncated JSON string payload", tool: "create_event", input: '{"title": "Meeting", "date": "2026-' },
    { label: "Event ending before it starts", tool: "create_event", input: { title: "Bad", date: "2026-11-02", start: "15:00", end: "14:00" } },
  ];
  const results = cases.map((c) => {
    const r = executeTool(rc, c.tool, c.input);
    return { label: c.label, tool: c.tool, rejected: !r.ok, error: r.ok ? null : r.error };
  });
  const stagedChanges = overlay.getChanges().length;
  const databaseUnchanged = fingerprint(db) === before;
  return { passed: results.every((r) => r.rejected) && stagedChanges === 0 && databaseUnchanged, stagedChanges, databaseUnchanged, results };
}
