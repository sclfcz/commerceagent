import { ChevronDown, ChevronUp } from 'lucide-react';
import { RefObject, useEffect, useState } from 'react';

interface ScrollEdgeAffordanceProps {
  scrollRef: RefObject<HTMLElement | null>;
}

interface ScrollEdges {
  canScroll: boolean;
  hasContentAbove: boolean;
  hasContentBelow: boolean;
}

const INITIAL_EDGES: ScrollEdges = {
  canScroll: false,
  hasContentAbove: false,
  hasContentBelow: false,
};

/**
 * A mobile-only edge hint for overflow panes.
 *
 * Mobile overlay scrollbars disappear while the user is idle, so they cannot
 * communicate that a pane has more content. These top/bottom fades remain
 * visible at rest without replacing or covering the native scrollbar.
 */
export function ScrollEdgeAffordance({ scrollRef }: ScrollEdgeAffordanceProps) {
  const [edges, setEdges] = useState<ScrollEdges>(INITIAL_EDGES);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;

    let animationFrame = 0;
    const update = () => {
      animationFrame = 0;
      const maxScrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
      const canScroll = maxScrollTop > 2;
      const next: ScrollEdges = {
        canScroll,
        hasContentAbove: canScroll && node.scrollTop > 2,
        hasContentBelow: canScroll && node.scrollTop < maxScrollTop - 2,
      };
      setEdges((current) =>
        current.canScroll === next.canScroll &&
        current.hasContentAbove === next.hasContentAbove &&
        current.hasContentBelow === next.hasContentBelow
          ? current
          : next,
      );
    };
    const scheduleUpdate = () => {
      if (!animationFrame) animationFrame = requestAnimationFrame(update);
    };

    node.addEventListener('scroll', scheduleUpdate, { passive: true });

    const resizeObserver = new ResizeObserver(scheduleUpdate);
    resizeObserver.observe(node);
    for (const child of node.children) resizeObserver.observe(child);

    const mutationObserver = new MutationObserver(() => {
      resizeObserver.disconnect();
      resizeObserver.observe(node);
      for (const child of node.children) resizeObserver.observe(child);
      scheduleUpdate();
    });
    mutationObserver.observe(node, { childList: true });

    update();
    return () => {
      node.removeEventListener('scroll', scheduleUpdate);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      if (animationFrame) cancelAnimationFrame(animationFrame);
    };
  }, [scrollRef]);

  if (!edges.canScroll) return null;

  return (
    <div
      className="pointer-events-none absolute inset-0 z-10 overflow-hidden lg:hidden"
      aria-hidden="true"
      data-testid="scroll-edge-affordance"
    >
      <div
        className={`absolute inset-x-0 top-0 flex h-9 justify-center bg-gradient-to-b from-background via-background/80 to-transparent pt-1 transition-opacity duration-150 ${
          edges.hasContentAbove ? 'opacity-100' : 'opacity-0'
        }`}
        data-testid="scroll-edge-above"
        data-visible={edges.hasContentAbove}
      >
        <ChevronUp className="h-4 w-4 text-muted-foreground" />
      </div>
      <div
        className={`absolute inset-x-0 bottom-0 flex h-10 items-end justify-center bg-gradient-to-t from-background via-background/80 to-transparent pb-1 transition-opacity duration-150 ${
          edges.hasContentBelow ? 'opacity-100' : 'opacity-0'
        }`}
        data-testid="scroll-edge-below"
        data-visible={edges.hasContentBelow}
      >
        <ChevronDown className="h-4 w-4 text-muted-foreground" />
      </div>
    </div>
  );
}
