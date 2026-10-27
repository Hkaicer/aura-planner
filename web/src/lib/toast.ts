import { create } from "zustand";

export interface Toast {
  id: number;
  message: string;
  tone: "neutral" | "error" | "success";
  action?: { label: string; run: () => void | Promise<void> };
}

interface ToastState {
  toasts: Toast[];
  push: (t: Omit<Toast, "id">, ttl?: number) => void;
  dismiss: (id: number) => void;
}

let next = 1;

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (t, ttl = 5000) => {
    const id = next++;
    set({ toasts: [...get().toasts.slice(-3), { ...t, id }] });
    window.setTimeout(() => get().dismiss(id), ttl);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const toast = {
  show: (t: { message: string; action?: Toast["action"] }) => useToasts.getState().push({ tone: "neutral", ...t }, t.action ? 7000 : 4000),
  success: (message: string) => useToasts.getState().push({ tone: "success", message }, 3500),
  error: (message: string) => useToasts.getState().push({ tone: "error", message }, 7000),
};
