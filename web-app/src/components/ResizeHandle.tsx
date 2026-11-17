'use client';

/**
 * A thin grab strip on one edge of a desktop side column. Drag to resize,
 * double-click to go back to the default width. Rules (min/max/collapse) live
 * in lib/panelWidth.ts; this only turns pointer movement into a requested
 * width.
 *
 * `edge` is which edge of the column the strip sits on: the sidebar grows to
 * the right (edge 'right'), the camera grows to the left (edge 'left').
 *
 * Pointer capture keeps the drag alive when the pointer leaves the strip or
 * crosses the <video> of the camera. Text selection and the cursor are forced
 * on <body> for the duration so a fast drag does not paint a selection across
 * the conversation.
 */

import React, { useRef } from 'react';

export default function ResizeHandle({
  edge,
  onDrag,
  onEnd,
  onReset,
  title,
}: {
  edge: 'left' | 'right';
  /** Live: the width the pointer is asking for (unclamped). */
  onDrag: (raw: number) => void;
  /** Released: the final requested width (unclamped). */
  onEnd: (raw: number) => void;
  onReset: () => void;
  title: string;
}) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  const rawFor = (clientX: number) => {
    const d = drag.current!;
    const dx = clientX - d.startX;
    return edge === 'right' ? d.startWidth + dx : d.startWidth - dx;
  };

  const end = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const raw = rawFor(e.clientX);
    drag.current = null;
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    onEnd(raw);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      title={title}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const column = e.currentTarget.parentElement;
        if (!column) return;
        e.preventDefault();
        drag.current = { startX: e.clientX, startWidth: column.getBoundingClientRect().width };
        e.currentTarget.setPointerCapture(e.pointerId);
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'col-resize';
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        onDrag(rawFor(e.clientX));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      className={`absolute top-0 bottom-0 ${edge === 'right' ? '-right-1' : '-left-1'} w-2 z-20 cursor-col-resize group`}
    >
      <div className="mx-auto h-full w-px bg-transparent group-hover:bg-indigo-400/60 transition-colors" />
    </div>
  );
}
