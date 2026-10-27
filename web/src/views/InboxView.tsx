import { ArrowRight, Inbox, ListPlus, Sun } from "lucide-react";
import { useState } from "react";
import { TaskRow, useRowContext } from "../components/task";
import { Empty, ErrorState, IconButton } from "../components/ui";
import { ViewHeader } from "../components/ViewHeader";
import { ListSkeleton } from "./CompletedView";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { errorMessage, useAction, useNow, useProjects, useTasks } from "../lib/queries";

export function InboxView() {
  const t = useT();
  const now = useNow();
  const inbox = useTasks("inbox");
  const projects = useProjects();
  const run = useAction();
  const [text, setText] = useState("");
  const ctx = useRowContext(inbox.data ?? [], projects.data, now);
  const capture = async () => {
    const title = text.trim();
    if (!title) return;
    setText("");
    await run(() => api.createTask({ title, status: "inbox" }), { success: t("toast.created", { title }), undoLabel: t("common.undo") });
  };
  return (
    <>
      <ViewHeader title={t("inbox.title")} sub={t("inbox.subtitle")} />
      <div className="view-body">
        <div className="view-inner view-inner-narrow">
          <div className="capture">
            <ListPlus />
            <input
              className="input input-bare"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t("inbox.capture")}
              aria-label={t("inbox.capture")}
              onKeyDown={(e) => {
                if (e.key === "Enter") void capture();
              }}
            />
          </div>
          {inbox.isLoading && <ListSkeleton rows={3} />}
          {inbox.isError && <ErrorState message={errorMessage(inbox.error)} onRetry={() => void inbox.refetch()} />}
          {inbox.data && inbox.data.length === 0 && <Empty icon={<Inbox />} title={t("inbox.empty.title")} body={t("inbox.empty.body")} />}
          {inbox.data && inbox.data.length > 0 && (
            <div className="task-list">
              {inbox.data.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  ctx={ctx}
                  extra={
                    <div className="inbox-actions">
                      <IconButton
                        size="sm"
                        label={t("action.process")}
                        onClick={() => void run(() => api.updateTask(task.id, { status: "todo", plannedDate: now.date }), { success: t("toast.moved", { when: t("common.today").toLowerCase() }), undoLabel: t("common.undo") })}
                      >
                        <Sun />
                      </IconButton>
                      <IconButton
                        size="sm"
                        label={t("inbox.toBacklog")}
                        onClick={() => void run(() => api.updateTask(task.id, { status: "todo" }), { success: t("toast.saved"), undoLabel: t("common.undo") })}
                      >
                        <ArrowRight />
                      </IconButton>
                    </div>
                  }
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
