import { AlertCircle, Check, CheckCircle2, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { useToasts } from "../lib/toast";

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type BtnVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-ghost";

export function Button({
  variant = "secondary",
  size,
  icon,
  loading,
  children,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: "sm" | "lg"; icon?: ReactNode; loading?: boolean }) {
  const cls = ["btn", variant !== "secondary" ? `btn-${variant}` : "", size ? `btn-${size}` : "", className].filter(Boolean).join(" ");
  return (
    <button type="button" className={cls} {...rest} disabled={rest.disabled || loading}>
      {loading ? <span className="spinner" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  children,
  size,
  tipPos,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: "sm"; tipPos?: "left" | "up" }) {
  return (
    <button
      type="button"
      aria-label={label}
      data-tip={label}
      {...(tipPos ? { "data-tip-pos": tipPos } : {})}
      className={`icon-btn ${size === "sm" ? "icon-btn-sm" : ""} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export const Kbd = ({ children }: { children: ReactNode }) => <kbd className="kbd">{children}</kbd>;

export function Badge({ tone = "neutral", dot, children, title }: { tone?: "neutral" | "accent" | "success" | "warning" | "danger" | "outline"; dot?: boolean; children: ReactNode; title?: string }) {
  return (
    <span className={`badge ${tone !== "neutral" ? `badge-${tone}` : ""} ${dot ? "badge-dot" : ""}`} title={title}>
      {children}
    </span>
  );
}

export function Spinner({ label }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label ?? "Loading"} />;
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" disabled={disabled} onClick={() => onChange(!checked)} />;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string; icon?: ReactNode; ariaLabel?: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          {...(o.ariaLabel ? { "aria-label": o.ariaLabel, "data-tip": o.ariaLabel } : {})}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children, htmlFor }: { label: ReactNode; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

export function ProgressRing({ value, size = 18 }: { value: number; size?: number }) {
  const r = (size - 3) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <svg className="ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle className="ring-track" cx={size / 2} cy={size / 2} r={r} />
      <circle className="ring-value" cx={size / 2} cy={size / 2} r={r} strokeDasharray={c} strokeDashoffset={c * (1 - v)} />
    </svg>
  );
}

export function Empty({ icon, title, body, children, small }: { icon?: ReactNode; title: string; body?: ReactNode; children?: ReactNode; small?: boolean }) {
  return (
    <div className={`empty ${small ? "empty-sm" : ""}`}>
      {icon && <div className="empty-icon">{icon}</div>}
      <h3>{title}</h3>
      {body && <p>{body}</p>}
      {children && <div className="row">{children}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry, retryLabel }: { message: string; onRetry?: () => void; retryLabel?: string }) {
  return (
    <div className="empty empty-sm" role="alert">
      <div className="empty-icon" style={{ color: "var(--danger)" }}>
        <AlertCircle />
      </div>
      <p>{message}</p>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          {retryLabel ?? "Try again"}
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Popover positioning and menus
// ---------------------------------------------------------------------------

export function usePopoverPosition(anchor: RefObject<HTMLElement | null>, open: boolean, align: "start" | "end" = "start") {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const place = () => {
      const a = anchor.current!.getBoundingClientRect();
      const el = ref.current;
      const w = el?.offsetWidth ?? 220;
      const h = el?.offsetHeight ?? 200;
      let left = align === "end" ? a.right - w : a.left;
      let top = a.bottom + 4;
      if (top + h > window.innerHeight - 8) top = Math.max(8, a.top - h - 4);
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
      setPos({ top, left });
    };
    place();
    const raf = requestAnimationFrame(place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchor, align]);
  return { ref, pos };
}

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  kbd?: string;
  hidden?: boolean;
}

export type MenuEntry = MenuItem | "sep" | { heading: string };

export function Menu({
  trigger,
  items,
  align = "start",
  label,
}: {
  trigger: (props: { ref: RefObject<HTMLButtonElement | null>; onClick: () => void; "aria-expanded": boolean; "aria-haspopup": "menu" }) => ReactNode;
  items: MenuEntry[];
  align?: "start" | "end";
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const { ref, pos } = usePopoverPosition(anchor, open, align);
  const visible = items.filter((i) => i === "sep" || "heading" in i || !(i as MenuItem).hidden);
  const actionable = visible.filter((i): i is MenuItem => i !== "sep" && !("heading" in i));
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (!open) return;
    setActive(0);
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        anchor.current?.focus();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => (a + 1) % actionable.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (a - 1 + actionable.length) % actionable.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = actionable[active];
        if (item) {
          setOpen(false);
          item.onSelect();
        }
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, actionable, active, ref]);

  let idx = -1;
  return (
    <>
      {trigger({ ref: anchor, onClick: () => setOpen((o) => !o), "aria-expanded": open, "aria-haspopup": "menu" })}
      {open &&
        createPortal(
          <div ref={ref} className="popover" role="menu" aria-label={label} style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}>
            {visible.map((item, i) => {
              if (item === "sep") return <div key={`s${i}`} className="menu-sep" />;
              if ("heading" in item) return <div key={`h${i}`} className="menu-label">{item.heading}</div>;
              idx++;
              const myIdx = idx;
              return (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  className={`menu-item ${item.danger ? "is-danger" : ""}`}
                  data-active={myIdx === active}
                  onMouseEnter={() => setActive(myIdx)}
                  onClick={() => {
                    setOpen(false);
                    item.onSelect();
                  }}
                >
                  {item.icon}
                  <span className="truncate">{item.label}</span>
                  {item.kbd && <Kbd>{item.kbd}</Kbd>}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}

/** A floating panel anchored to an element (for pickers and small forms). */
export function Popover({
  anchor,
  open,
  onClose,
  children,
  align = "start",
  width,
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  align?: "start" | "end";
  width?: number;
}) {
  const { ref, pos } = usePopoverPosition(anchor, open, align);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, onClose, anchor, ref]);
  if (!open) return null;
  return createPortal(
    <div ref={ref} className="popover" style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width, maxWidth: width ? "none" : undefined, padding: 12 }}>
      {children}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

const DialogDepth = createContext(0);
let openDialogs = 0;

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  size,
  icon,
  labelledBy,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "lg" | "xl";
  icon?: ReactNode;
  labelledBy?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const depth = useContext(DialogDepth);
  useEffect(() => {
    if (!open) return;
    openDialogs++;
    const previous = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const focusable = () =>
      Array.from(el?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select, textarea, [tabindex]:not([tabindex="-1"])') ?? []);
    window.setTimeout(() => {
      // Focus the requested field, otherwise the dialog itself (never the close button).
      const auto = el?.querySelector<HTMLElement>("[data-autofocus]") ?? el;
      auto?.focus({ preventScroll: true });
    }, 20);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "Tab") {
        const items = focusable();
        if (items.length === 0) return;
        const first = items[0]!;
        const last = items[items.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    el?.addEventListener("keydown", onKey);
    return () => {
      openDialogs--;
      el?.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <DialogDepth.Provider value={depth + 1}>
      <div
        className="overlay"
        style={{ zIndex: 50 + depth * 2 }}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div ref={ref} className={`dialog ${size ? `dialog-${size}` : ""}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy} tabIndex={-1}>
          {title && (
            <div className="dialog-header">
              {icon}
              <h2 className="dialog-title" id={labelledBy}>
                {title}
              </h2>
              <span className="spacer" />
              <IconButton label="Close" onClick={onClose} tipPos="left">
                <X />
              </IconButton>
            </div>
          )}
          {children}
          {footer && <div className="dialog-footer">{footer}</div>}
        </div>
      </div>
    </DialogDepth.Provider>,
    document.body,
  );
}

export const isDialogOpen = () => openDialogs > 0;

// ---------------------------------------------------------------------------
// Imperative confirmation dialog
// ---------------------------------------------------------------------------

interface ConfirmRequest {
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  requireText?: string;
  option?: { label: string; default: boolean };
  resolve: (v: { ok: boolean; option: boolean }) => void;
}

const useConfirmStore = create<{ req: ConfirmRequest | null; set: (r: ConfirmRequest | null) => void }>((set) => ({ req: null, set: (req) => set({ req }) }));

export function confirmAction(opts: Omit<ConfirmRequest, "resolve">): Promise<{ ok: boolean; option: boolean }> {
  return new Promise((resolve) => useConfirmStore.getState().set({ ...opts, resolve }));
}

export function ConfirmHost() {
  const { req, set } = useConfirmStore();
  const [typed, setTyped] = useState("");
  const [option, setOption] = useState(false);
  useEffect(() => {
    setTyped("");
    setOption(req?.option?.default ?? false);
  }, [req]);
  const close = useCallback(
    (ok: boolean) => {
      req?.resolve({ ok, option });
      set(null);
    },
    [req, set, option],
  );
  if (!req) return null;
  const blocked = req.requireText !== undefined && typed !== req.requireText;
  return (
    <Dialog open onClose={() => close(false)} size="sm" title={req.title} labelledBy="confirm-title">
      <div className="dialog-body">
        {req.body && <div className="dialog-desc">{req.body}</div>}
        {req.option && (
          <label className="checkbox-line">
            <input type="checkbox" checked={option} onChange={(e) => setOption(e.target.checked)} />
            {req.option.label}
          </label>
        )}
        {req.requireText !== undefined && (
          <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={req.requireText} aria-label={req.requireText} data-autofocus />
        )}
      </div>
      <div className="dialog-footer">
        <Button variant="ghost" onClick={() => close(false)}>
          {req.cancelLabel ?? "Cancel"}
        </Button>
        <Button variant={req.danger ? "danger" : "primary"} onClick={() => close(true)} disabled={blocked} {...(req.requireText === undefined ? { "data-autofocus": true } : {})}>
          {req.confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

export function Toaster() {
  const { toasts, dismiss } = useToasts();
  return (
    <div className="toast-region" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`}>
          {t.tone === "error" ? <AlertCircle /> : t.tone === "success" ? <CheckCircle2 /> : <Check />}
          <span>{t.message}</span>
          {t.action && (
            <button
              type="button"
              onClick={() => {
                dismiss(t.id);
                void t.action!.run();
              }}
            >
              {t.action.label}
            </button>
          )}
          <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <X />
          </button>
        </div>
      ))}
    </div>
  );
}
