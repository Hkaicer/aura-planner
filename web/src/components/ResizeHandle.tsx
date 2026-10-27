import type { KeyboardEvent, PointerEvent } from "react";

interface Range {
  default: number;
  min: number;
  max: number;
}

const setWidthVar = (cssVar: string, width: number) => document.documentElement.style.setProperty(cssVar, `${width}px`);

/**
 * Draggable edge that resizes a side column. While dragging it only updates
 * the column's CSS variable (no re-render); the final width is committed once
 * on release. Double-click restores the default width.
 */
export function ResizeHandle({
  edge,
  cssVar,
  range,
  value,
  measure,
  available,
  label,
  className = "",
  onCommit,
}: {
  /** Edge of the column the handle sits on: "right" for the sidebar, "left" for the assistant. */
  edge: "left" | "right";
  cssVar: string;
  range: Range;
  value: number;
  /** Width of the column as rendered now (small windows can show it narrower than stored). */
  measure: () => number;
  /** Largest width the window currently leaves room for. */
  available: () => number;
  label: string;
  className?: string;
  onCommit: (width: number) => void;
}) {
  const limit = (width: number) => Math.round(Math.max(range.min, Math.min(range.max, available(), width)));

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    const startX = e.clientX;
    const startW = measure();
    let width = startW;
    el.setPointerCapture(e.pointerId);
    el.classList.add("is-dragging");
    document.body.classList.add("is-resizing");
    const onMove = (ev: globalThis.PointerEvent) => {
      const dx = ev.clientX - startX;
      width = limit(edge === "right" ? startW + dx : startW - dx);
      setWidthVar(cssVar, width);
    };
    const onEnd = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onEnd);
      el.removeEventListener("pointercancel", onEnd);
      el.classList.remove("is-dragging");
      document.body.classList.remove("is-resizing");
      if (Math.round(width) !== Math.round(startW)) onCommit(width);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onEnd);
    el.addEventListener("pointercancel", onEnd);
  };

  const commit = (width: number) => {
    setWidthVar(cssVar, width);
    onCommit(width);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 48 : 16;
    const grow = edge === "right" ? "ArrowRight" : "ArrowLeft";
    const shrink = edge === "right" ? "ArrowLeft" : "ArrowRight";
    let next: number | null = null;
    if (e.key === grow) next = measure() + step;
    else if (e.key === shrink) next = measure() - step;
    else if (e.key === "Home") next = range.min;
    else if (e.key === "End") next = range.max;
    else if (e.key === "Enter") next = range.default;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    commit(limit(next));
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={range.min}
      aria-valuemax={range.max}
      aria-valuenow={value}
      tabIndex={0}
      className={`resize-handle is-${edge} ${className}`}
      onPointerDown={onPointerDown}
      onDoubleClick={() => commit(range.default)}
      onKeyDown={onKeyDown}
    />
  );
}
