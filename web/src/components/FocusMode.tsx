import { useQuery } from "@tanstack/react-query";
import { Check, Coffee, Pause, Play, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Task } from "@shared/schemas";
import { formatDuration } from "@shared/time";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { invalidatePlanning, useAction } from "../lib/queries";
import { useUi } from "../lib/store";
import { useQueryClient } from "@tanstack/react-query";
import { PriorityIcon } from "./task";
import { Button, Segmented } from "./ui";

const POMODORO = 25 * 60;
const SHORT_BREAK = 5 * 60;

function fmt(seconds: number) {
  const s = Math.max(0, Math.round(Math.abs(seconds)));
  const m = Math.floor(s / 60);
  return `${seconds < 0 ? "+" : ""}${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function FocusHost() {
  const ui = useUi();
  const id = ui.focusTaskId;
  const q = useQuery({ queryKey: ["task", id], queryFn: () => api.task(id!), enabled: Boolean(id) });
  if (!id || !q.data) return null;
  return <Focus key={id} task={q.data} onExit={() => ui.set({ focusTaskId: null })} />;
}

function Focus({ task, onExit }: { task: Task; onExit: () => void }) {
  const t = useT();
  const run = useAction();
  const qc = useQueryClient();
  const [mode, setMode] = useState<"countdown" | "pomodoro">("countdown");
  const [running, setRunning] = useState(true);
  const [elapsed, setElapsed] = useState(0); // seconds of focus in this session
  const [phase, setPhase] = useState<"focus" | "break">("focus");
  const [phaseElapsed, setPhaseElapsed] = useState(0);
  const [sessions, setSessions] = useState(1);
  const startedAt = useRef<Date | null>(new Date());
  const [subtasks, setSubtasks] = useState(task.subtasks);

  // Record the focused stretch as a time entry whenever the clock stops.
  const flush = useCallback(async () => {
    if (!startedAt.current) return;
    const from = startedAt.current;
    startedAt.current = null;
    const end = new Date();
    if (end.getTime() - from.getTime() < 30_000) return;
    try {
      await api.logTime(task.id, from.toISOString(), end.toISOString(), mode === "pomodoro" ? "pomodoro" : "focus");
    } catch {
      // time tracking is best effort; the task itself is unaffected
    }
  }, [task.id, mode]);

  useEffect(() => {
    if (task.status !== "in_progress" && task.status !== "done") void api.startTask(task.id).then(() => invalidatePlanning(qc)).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => {
      setPhaseElapsed((p) => p + 1);
      if (phase === "focus") setElapsed((e) => e + 1);
    }, 1000);
    return () => window.clearInterval(id);
  }, [running, phase]);

  useEffect(() => {
    if (mode !== "pomodoro") return;
    const limit = phase === "focus" ? POMODORO : SHORT_BREAK;
    if (phaseElapsed >= limit) {
      if (phase === "focus") {
        void flush();
        setPhase("break");
      } else {
        startedAt.current = new Date();
        setPhase("focus");
        setSessions((s) => s + 1);
      }
      setPhaseElapsed(0);
      try {
        if ("Notification" in window && Notification.permission === "granted") new Notification(phase === "focus" ? t("focus.break") : task.title);
      } catch {
        // notifications are optional
      }
    }
  }, [phaseElapsed, mode, phase, flush, t, task.title]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void exit();
      } else if (e.key === " " && (e.target as HTMLElement).tagName !== "BUTTON") {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const toggle = () => {
    if (running) {
      void flush();
      setRunning(false);
    } else {
      if (phase === "focus") startedAt.current = new Date();
      setRunning(true);
    }
  };

  const exit = async () => {
    await flush();
    invalidatePlanning(qc);
    onExit();
  };

  const complete = async () => {
    await flush();
    const res = await run(() => api.completeTask(task.id), { success: t("toast.completed", { title: task.title }), undoLabel: t("common.undo") });
    if (res) onExit();
  };

  const toggleSub = async (id: string) => {
    setSubtasks((s) => s.map((x) => (x.id === id ? { ...x, done: !x.done } : x)));
    await run(() => api.subtasks(task.id, { toggle: [id] }), { silent: true });
  };

  const remaining = mode === "pomodoro" ? (phase === "focus" ? POMODORO : SHORT_BREAK) - phaseElapsed : task.estimateMin * 60 - elapsed;
  const total = mode === "pomodoro" ? (phase === "focus" ? POMODORO : SHORT_BREAK) : task.estimateMin * 60;
  const progress = Math.min(1, (mode === "pomodoro" ? phaseElapsed : elapsed) / total);
  const R = 120;
  const C = 2 * Math.PI * R;

  return (
    <div className="focus" role="dialog" aria-modal="true" aria-label={t("focus.title")}>
      <div className="focus-top">
        <Segmented
          label={t("focus.title")}
          value={mode}
          onChange={(v) => {
            setMode(v);
            setPhase("focus");
            setPhaseElapsed(0);
          }}
          options={[
            { value: "countdown", label: t("focus.countdown") },
            { value: "pomodoro", label: t("focus.pomodoro") },
          ]}
        />
        <span className="spacer" />
        <Button variant="ghost" icon={<X />} onClick={() => void exit()}>
          {t("focus.exit")}
        </Button>
      </div>
      <div className="focus-center">
        <div className="focus-task">
          <PriorityIcon priority={task.priority} />
          <h2>{task.title}</h2>
        </div>
        {task.description && <p className="focus-desc">{task.description}</p>}
        <div className={`focus-clock ${phase === "break" ? "is-break" : ""} ${remaining < 0 ? "is-over" : ""}`}>
          <svg width="280" height="280" viewBox="0 0 280 280" aria-hidden>
            <circle cx="140" cy="140" r={R} className="focus-track" />
            <circle cx="140" cy="140" r={R} className="focus-value" strokeDasharray={C} strokeDashoffset={C * (1 - progress)} />
          </svg>
          <div className="focus-time">
            <span className="tnum">{fmt(remaining)}</span>
            <span className="focus-label">
              {phase === "break" ? (
                <>
                  <Coffee /> {t("focus.break")}
                </>
              ) : mode === "pomodoro" ? (
                t("focus.session", { n: sessions })
              ) : remaining < 0 ? (
                t("focus.over")
              ) : (
                t("focus.elapsed", { time: formatDuration(Math.floor(elapsed / 60)) })
              )}
            </span>
          </div>
        </div>
        <div className="focus-controls">
          <Button size="lg" icon={running ? <Pause /> : <Play />} onClick={toggle}>
            {running ? t("focus.pause") : t("focus.resume")}
          </Button>
          <Button size="lg" variant="primary" icon={<Check />} onClick={() => void complete()}>
            {t("focus.complete")}
          </Button>
        </div>
        {subtasks.length > 0 && (
          <ul className="focus-subtasks">
            {subtasks.map((s) => (
              <li key={s.id}>
                <button type="button" role="checkbox" aria-checked={s.done} className={`task-check ${s.done ? "is-checked" : ""}`} style={{ width: 16, height: 16 }} onClick={() => void toggleSub(s.id)}>
                  {s.done && <Check strokeWidth={3} />}
                </button>
                <span className={s.done ? "is-done" : ""}>{s.title}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
