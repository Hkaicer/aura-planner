import {
  CalendarDays,
  CalendarRange,
  CheckCircle2,
  Circle,
  Contrast,
  Crosshair,
  FolderKanban,
  Inbox,
  Keyboard,
  ListTodo,
  Plus,
  Search,
  Settings,
  Sparkles,
  Sun,
  Undo2,
  Wand2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Task } from "@shared/schemas";
import { relativeDay } from "../lib/format";
import { useLang, useT } from "../lib/i18n";
import { useNow, useTasks } from "../lib/queries";
import { useUi, type View } from "../lib/store";
import { Dialog, Kbd } from "./ui";

interface Command {
  id: string;
  label: string;
  group: string;
  icon: ReactNode;
  hint?: string;
  run: () => void;
}

export function CommandPalette({ onUndo, onToggleTheme, onPlanToday, onFocus }: { onUndo: () => void; onToggleTheme: () => void; onPlanToday: () => void; onFocus: () => void }) {
  const ui = useUi();
  if (!ui.paletteOpen) return null;
  return <Palette onClose={() => ui.set({ paletteOpen: false })} onUndo={onUndo} onToggleTheme={onToggleTheme} onPlanToday={onPlanToday} onFocus={onFocus} />;
}

function Palette({ onClose, onUndo, onToggleTheme, onPlanToday, onFocus }: { onClose: () => void; onUndo: () => void; onToggleTheme: () => void; onPlanToday: () => void; onFocus: () => void }) {
  const t = useT();
  const lang = useLang();
  const ui = useUi();
  const now = useNow();
  const tasks = useTasks("all");
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const go = (view: View) => () => ui.setView(view, view === "projects" ? { projectId: null } : {});
  const commands: Command[] = useMemo(
    () => [
      { id: "new", label: t("nav.newTask"), group: t("palette.actions"), icon: <Plus />, hint: "N", run: () => ui.set({ quickAdd: {} }) },
      { id: "ask", label: t("nav.ask"), group: t("palette.actions"), icon: <Sparkles />, hint: "J", run: () => ui.askAssistant("") },
      { id: "plan", label: t("palette.planDay"), group: t("palette.actions"), icon: <Wand2 />, run: onPlanToday },
      { id: "focus", label: t("palette.focus"), group: t("palette.actions"), icon: <Crosshair />, hint: "F", run: onFocus },
      { id: "undo", label: t("palette.undo"), group: t("palette.actions"), icon: <Undo2 />, hint: "Ctrl Z", run: onUndo },
      { id: "theme", label: t("palette.toggleTheme"), group: t("palette.actions"), icon: <Contrast />, run: onToggleTheme },
      { id: "keys", label: t("palette.shortcuts"), group: t("palette.actions"), icon: <Keyboard />, hint: "?", run: () => ui.set({ dialog: "shortcuts" }) },
      { id: "today", label: t("nav.today"), group: t("palette.navigation"), icon: <Sun />, hint: "G T", run: go("today") },
      { id: "upcoming", label: t("nav.upcoming"), group: t("palette.navigation"), icon: <CalendarRange />, hint: "G U", run: go("upcoming") },
      { id: "inbox", label: t("nav.inbox"), group: t("palette.navigation"), icon: <Inbox />, hint: "G I", run: go("inbox") },
      { id: "all", label: t("nav.all"), group: t("palette.navigation"), icon: <ListTodo />, hint: "G A", run: go("all") },
      { id: "projects", label: t("nav.projects"), group: t("palette.navigation"), icon: <FolderKanban />, hint: "G P", run: go("projects") },
      { id: "calendar", label: t("nav.calendar"), group: t("palette.navigation"), icon: <CalendarDays />, hint: "G C", run: go("calendar") },
      { id: "completed", label: t("nav.completed"), group: t("palette.navigation"), icon: <CheckCircle2 />, hint: "G D", run: go("completed") },
      { id: "settings", label: t("nav.settings"), group: t("palette.navigation"), icon: <Settings />, hint: "G S", run: go("settings") },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t],
  );

  const query = q.trim().toLowerCase();
  const matchedCommands = commands.filter((c) => !query || c.label.toLowerCase().includes(query));
  const matchedTasks: Task[] = useMemo(() => {
    if (!query) return [];
    const seen = new Set<string>();
    return (tasks.data ?? [])
      .filter((x) => `${x.title} ${x.tags.join(" ")}`.toLowerCase().includes(query))
      .sort((a, b) => Number(a.status === "done") - Number(b.status === "done") || (a.plannedDate ?? "~").localeCompare(b.plannedDate ?? "~"))
      .filter((x) => {
        // Show a recurring series once: its next open occurrence.
        if (!x.recurrenceParentId) return true;
        if (seen.has(x.recurrenceParentId)) return false;
        seen.add(x.recurrenceParentId);
        return true;
      })
      .slice(0, 8);
  }, [tasks.data, query]);
  const items: Command[] = [
    ...matchedCommands,
    ...matchedTasks.map((task) => ({
      id: task.id,
      label: task.title,
      group: t("palette.tasks"),
      icon: task.status === "done" ? <CheckCircle2 className="is-done-icon" /> : <Circle />,
      hint: task.plannedDate ? relativeDay(task.plannedDate, now.date, lang, t) : undefined,
      run: () => ui.set({ editingTaskId: task.id }),
    })),
  ];

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const exec = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };

  let lastGroup = "";
  return (
    <Dialog open onClose={onClose} size="lg" labelledBy="palette-input">
      <div className="palette">
        <div className="palette-search">
          <Search />
          <input
            id="palette-input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("palette.placeholder")}
            data-autofocus
            aria-label={t("palette.placeholder")}
            aria-activedescendant={items[active] ? `pal-${items[active]!.id}` : undefined}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(items.length - 1, a + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                exec(items[active]);
              }
            }}
          />
          <Kbd>Esc</Kbd>
        </div>
        <div className="palette-list" ref={listRef} role="listbox">
          {items.length === 0 && <div className="palette-empty">{t("palette.noResults")}</div>}
          {items.map((c, i) => {
            const heading = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {heading && <div className="palette-group">{heading}</div>}
                <button
                  type="button"
                  id={`pal-${c.id}`}
                  role="option"
                  aria-selected={i === active}
                  data-index={i}
                  className="palette-item"
                  onMouseMove={() => setActive(i)}
                  onClick={() => exec(c)}
                >
                  {c.icon}
                  <span className="truncate">{c.label}</span>
                  {c.hint && <span className="palette-hint">{c.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </Dialog>
  );
}
