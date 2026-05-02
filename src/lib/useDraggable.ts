import { useCallback, useRef, useState } from "react";

interface Position { x: number; y: number }

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function useDraggable() {
  const [pos, setPos] = useState<Position | null>(null);
  const dragging = useRef(false);
  const origin = useRef<Position>({ x: 0, y: 0 });
  const startPos = useRef<Position>({ x: 0, y: 0 });
  const elementRef = useRef<HTMLElement | null>(null);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging.current = true;
    origin.current = { x: e.clientX, y: e.clientY };
    startPos.current = pos ?? { x: 0, y: 0 };
    // Grab the modal element (parent of the drag handle)
    elementRef.current = (e.currentTarget as HTMLElement).parentElement;

    function onMove(ev: MouseEvent) {
      if (!dragging.current) return;
      const rawX = startPos.current.x + ev.clientX - origin.current.x;
      const rawY = startPos.current.y + ev.clientY - origin.current.y;

      // Modal starts CSS-centered. translate(x,y) is relative to that center.
      // Keep at least `margin` px of the modal visible on each edge.
      const el = elementRef.current;
      const margin = 60;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const w = el ? el.offsetWidth : 400;
      const h = el ? el.offsetHeight : 300;
      const halfW = w / 2;
      const halfH = h / 2;

      // Modal left edge = vw/2 - halfW + x. Must be >= margin.
      // Modal right edge = vw/2 + halfW + x. Must be <= vw - margin.
      const minX = margin - (vw / 2 - halfW);
      const maxX = (vw / 2 - halfW) - margin;
      const minY = margin - (vh / 2 - halfH);
      const maxY = (vh / 2 - halfH) - margin;

      setPos({ x: clamp(rawX, minX, maxX), y: clamp(rawY, minY, maxY) });
    }

    function onUp() {
      dragging.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [pos]);

  const style: React.CSSProperties = pos
    ? { transform: `translate(${pos.x}px, ${pos.y}px)` }
    : {};

  return { onMouseDown, style };
}
