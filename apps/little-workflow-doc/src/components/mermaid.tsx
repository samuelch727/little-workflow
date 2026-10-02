'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';
import {
  Check,
  Copy,
  Download,
  Maximize2,
  Minimize2,
  RotateCcw,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';

type MermaidProps = {
  chart: string;
};

mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'default',
  themeVariables: {
    fontFamily: 'var(--font-mono, ui-monospace)',
  },
  flowchart: { htmlLabels: true, curve: 'linear' },
  sequence: { useMaxWidth: true },
});

const MIN_SCALE = 0.5;
const MAX_SCALE = 4;
const ZOOM_LEVELS = [0.5, 0.6, 0.75, 0.9, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 3.5, 4.0];

export function Mermaid({ chart }: MermaidProps) {
  const id = useId().replace(/[^A-Za-z0-9_-]/g, '_');
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [dragging, setDragging] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<
    | { pointerId: number; startX: number; startY: number; scrollLeft: number; scrollTop: number }
    | null
  >(null);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const naturalWidthRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    mermaid
      .render(`m_${id}`, chart)
      .then(({ svg }) => {
        if (cancelled) return;
        // Strip the inline max-width and width="100%" mermaid emits so we
        // can drive width explicitly from the scale state below.
        const cleaned = svg
          .replace(/(<svg[^>]*)\s+width="100%"/, '$1')
          .replace(/(<svg[^>]*)style="[^"]*max-width:[^"]*"/, '$1');
        const viewBox = /viewBox="([^"]+)"/.exec(cleaned)?.[1];
        const widthFromViewBox = viewBox ? Number(viewBox.split(/\s+/)[2]) : null;
        if (
          widthFromViewBox !== null &&
          Number.isFinite(widthFromViewBox) &&
          widthFromViewBox > 0
        ) {
          naturalWidthRef.current = widthFromViewBox;
        }
        setSvg(cleaned);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [chart, id]);

  // Inject the SVG ourselves rather than via dangerouslySetInnerHTML.
  // dangerouslySetInnerHTML re-applies on every React re-render which wipes
  // the inline width style we set below — that's how zoom got reset when the
  // user started dragging (setDragging triggered a re-render).
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return;
    stage.innerHTML = svg ?? '';
  }, [svg]);

  // Apply the current scale by setting the SVG width directly. SVG preserves
  // aspect ratio from viewBox, so the height follows automatically.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    const natural = naturalWidthRef.current;
    if (stage === null || natural === null) return;
    const svgEl = stage.querySelector('svg');
    if (svgEl === null) return;
    svgEl.style.width = `${natural * scale}px`;
    svgEl.style.height = 'auto';
    svgEl.style.maxWidth = 'none';
  }, [svg, scale]);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  const zoomIn = () =>
    setScale((current) => ZOOM_LEVELS.find((level) => level > current + 1e-3) ?? MAX_SCALE);
  const zoomOut = () =>
    setScale(
      (current) =>
        [...ZOOM_LEVELS].reverse().find((level) => level < current - 1e-3) ?? MIN_SCALE,
    );
  const reset = () => setScale(1);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('button')) return;
    const el = scrollRef.current;
    if (el === null) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: el.scrollLeft,
      scrollTop: el.scrollTop,
    };
    setDragging(true);
  }, []);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const el = scrollRef.current;
    if (drag === null || el === null || drag.pointerId !== event.pointerId) return;
    el.scrollLeft = drag.scrollLeft - (event.clientX - drag.startX);
    el.scrollTop = drag.scrollTop - (event.clientY - drag.startY);
  }, []);

  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* pointer may already be released */
    }
    dragRef.current = null;
    setDragging(false);
  }, []);

  const copyChart = async () => {
    try {
      await navigator.clipboard.writeText(chart);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  };

  const downloadSvg = () => {
    if (svg === null) return;
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `mermaid-${id}.svg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  if (error !== null) {
    return (
      <pre className="my-4 overflow-x-auto rounded-md border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-600">
        {`Mermaid render error: ${error}\n\n${chart}`}
      </pre>
    );
  }

  return (
    <>
      {fullscreen && (
        <div
          className="fixed inset-0 z-[70] bg-black/50 backdrop-blur-sm"
          onClick={() => setFullscreen(false)}
          aria-hidden
        />
      )}
      <div
        className={
          fullscreen
            ? 'fixed inset-6 z-[80] flex flex-col rounded-lg border bg-fd-card shadow-2xl'
            : 'relative my-6 flex flex-col rounded-md border bg-fd-card'
        }
        style={fullscreen ? undefined : { height: 'min(60vh, 480px)' }}
        aria-label="Mermaid diagram"
      >
        <div
          ref={scrollRef}
          className="relative flex-1 select-none overflow-auto touch-none"
          style={{ cursor: dragging ? 'grabbing' : 'grab' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div
            ref={stageRef}
            className="flex w-fit min-w-full justify-center p-6 [&_svg]:pointer-events-none"
          />
        </div>

        <div
          className="absolute bottom-2 left-2 z-10 flex flex-col gap-1 rounded-md border bg-fd-card/85 p-1 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-fd-card/70"
          aria-label="Diagram controls"
        >
          <IconButton
            title="Zoom in"
            disabled={scale >= MAX_SCALE - 1e-3}
            onClick={zoomIn}
            icon={<ZoomIn className="h-4 w-4" />}
          />
          <IconButton
            title="Zoom out"
            disabled={scale <= MIN_SCALE + 1e-3}
            onClick={zoomOut}
            icon={<ZoomOut className="h-4 w-4" />}
          />
          <IconButton
            title="Reset zoom"
            onClick={reset}
            icon={<RotateCcw className="h-4 w-4" />}
          />
        </div>

        <div
          className="absolute top-2 right-2 z-10 flex gap-1 rounded-md border bg-fd-card/85 p-1 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-fd-card/70"
          aria-label="Diagram tools"
        >
          <span className="flex items-center px-2 text-xs tabular-nums text-fd-muted-foreground select-none">
            {Math.round(scale * 100)}%
          </span>
          <IconButton
            title={copied ? 'Copied!' : 'Copy chart source'}
            onClick={copyChart}
            icon={copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          />
          <IconButton
            title="Download SVG"
            onClick={downloadSvg}
            disabled={svg === null}
            icon={<Download className="h-4 w-4" />}
          />
          <IconButton
            title={fullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
            onClick={() => setFullscreen((prev) => !prev)}
            icon={
              fullscreen ? (
                <Minimize2 className="h-4 w-4" />
              ) : (
                <Maximize2 className="h-4 w-4" />
              )
            }
          />
          {fullscreen && (
            <IconButton
              title="Close (Esc)"
              onClick={() => setFullscreen(false)}
              icon={<X className="h-4 w-4" />}
            />
          )}
        </div>
      </div>
    </>
  );
}

function IconButton({
  title,
  onClick,
  icon,
  disabled = false,
}: {
  title: string;
  onClick: () => void;
  icon: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-7 w-7 items-center justify-center rounded text-fd-muted-foreground transition-colors hover:bg-fd-muted hover:text-fd-foreground disabled:cursor-not-allowed disabled:opacity-40"
    >
      {icon}
    </button>
  );
}
