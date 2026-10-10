import { useRef, useState, type ReactNode } from 'react';

// A column whose edge drags to resize it (the cockpit's Time and Later). The width is saved once,
// on release; while dragging it lives here, so the prefs aren't written on every pointer move.

export interface WidthBounds {
  default: number;
  min: number;
  max: number;
}

export const clampWidth = (px: number, b: WidthBounds) => Math.round(Math.min(b.max, Math.max(b.min, px)));

/**
 * The column's width and the handle for its edge: `right` for a column on the left (dragging right
 * widens it), `left` for one on the right. Focused, the arrow keys move the edge; a double-click
 * puts it back to the default.
 */
export function useResizable({ saved, save, bounds, edge, label }: { saved: number; save: (px: number) => void; bounds: WidthBounds; edge: 'left' | 'right'; label: string }): { width: number; dragging: boolean; handle: ReactNode } {
  const [dragged, setDragged] = useState<number | null>(null);
  const drag = useRef<{ x: number; from: number } | null>(null);
  const width = clampWidth(dragged ?? saved, bounds);
  const sign = edge === 'right' ? 1 : -1;
  const at = (clientX: number) => clampWidth(drag.current!.from + sign * (clientX - drag.current!.x), bounds);
  const commit = (px: number) => {
    save(clampWidth(px, bounds));
    setDragged(null);
  };

  const handle = (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      tabIndex={0}
      title="Drag to resize; double-click to reset"
      className={`group absolute top-0 bottom-0 z-10 flex w-[9px] cursor-col-resize justify-center !outline-none ${edge === 'right' ? '-right-[5px]' : '-left-[5px]'}`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, from: width };
      }}
      onPointerMove={(e) => drag.current && setDragged(at(e.clientX))}
      onPointerUp={(e) => {
        if (!drag.current) return;
        commit(at(e.clientX));
        drag.current = null;
      }}
      onPointerCancel={() => ((drag.current = null), setDragged(null))}
      onDoubleClick={() => commit(bounds.default)}
      onKeyDown={(e) => {
        const step = e.key === 'ArrowRight' ? 20 : e.key === 'ArrowLeft' ? -20 : 0;
        if (!step) return;
        e.preventDefault();
        commit(width + sign * step);
      }}
    >
      <span aria-hidden className="w-[3px] rounded-full bg-transparent transition-colors group-hover:bg-accent-line group-focus-visible:bg-accent group-active:bg-accent" />
    </div>
  );
  return { width, dragging: dragged !== null, handle };
}
