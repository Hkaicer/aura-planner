import { keepPreviousData, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { zonedNow, type ZonedNow } from "@shared/time";
import { api, ApiError, type Mutation } from "./api";
import { toast } from "./toast";

export const qk = {
  boot: ["bootstrap"] as const,
  day: (date: string) => ["day", date] as const,
  range: (from: string, to: string) => ["range", from, to] as const,
  tasks: (scope: string) => ["tasks", scope] as const,
  projects: ["projects"] as const,
  aiStatus: ["ai-status"] as const,
  conversation: ["conversation"] as const,
  stats: ["stats"] as const,
  history: ["history"] as const,
  backups: ["backups"] as const,
  events: (from: string, to: string) => ["events", from, to] as const,
};

export function invalidatePlanning(qc: QueryClient) {
  for (const key of ["day", "range", "tasks", "projects", "stats", "history", "events", "bootstrap"]) {
    void qc.invalidateQueries({ queryKey: [key] });
  }
}

export const useBootstrap = () => useQuery({ queryKey: qk.boot, queryFn: api.bootstrap, staleTime: 60_000 });

export function useSettings() {
  return useBootstrap().data?.settings;
}

export const useDay = (date: string) => useQuery({ queryKey: qk.day(date), queryFn: () => api.day(date), refetchInterval: 60_000 });

export const useRange = (from: string, to: string) =>
  useQuery({ queryKey: qk.range(from, to), queryFn: () => api.range(from, to), placeholderData: keepPreviousData });

export const useTasks = (scope: "all" | "open" | "done" | "inbox" | "backlog" | "templates" = "all") =>
  useQuery({ queryKey: qk.tasks(scope), queryFn: () => api.tasks(scope) });

export const useProjects = () => useQuery({ queryKey: qk.projects, queryFn: api.projects });

export const useAiStatus = () =>
  useQuery({ queryKey: qk.aiStatus, queryFn: () => api.aiStatus(), refetchInterval: 60_000, staleTime: 20_000 });

export const useConversation = () => useQuery({ queryKey: qk.conversation, queryFn: api.conversation });

export const useStats = () => useQuery({ queryKey: qk.stats, queryFn: () => api.stats(14) });

/** Current wall-clock time in the configured time zone, refreshed every 30 seconds. */
export function useNow(): ZonedNow {
  const tz = useSettings()?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [now, setNow] = useState(() => zonedNow(tz));
  useEffect(() => {
    setNow(zonedNow(tz));
    const id = window.setInterval(() => setNow(zonedNow(tz)), 30_000);
    return () => window.clearInterval(id);
  }, [tz]);
  return now;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

/**
 * Run a mutation, refresh planning data, and offer Undo when the server
 * recorded the change in history.
 */
export function useAction() {
  const qc = useQueryClient();
  return useCallback(
    async <T>(fn: () => Promise<Mutation<T> | T>, opts: { success?: string; undoLabel?: string; silent?: boolean } = {}): Promise<T | null> => {
      try {
        const res = await fn();
        invalidatePlanning(qc);
        const historyId = res && typeof res === "object" && "historyId" in res ? (res as Mutation<T>).historyId : null;
        if (opts.success && !opts.silent) {
          toast.show({
            message: opts.success,
            ...(historyId
              ? {
                  action: {
                    label: opts.undoLabel ?? "Undo",
                    run: async () => {
                      try {
                        await api.undo(historyId);
                        invalidatePlanning(qc);
                      } catch (err) {
                        toast.error(errorMessage(err));
                      }
                    },
                  },
                }
              : {}),
          });
        }
        return res && typeof res === "object" && "result" in res ? (res as Mutation<T>).result : (res as T);
      } catch (err) {
        toast.error(errorMessage(err));
        invalidatePlanning(qc);
        return null;
      }
    },
    [qc],
  );
}
