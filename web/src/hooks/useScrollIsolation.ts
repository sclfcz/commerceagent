import { useEffect, RefObject } from 'react';

/**
 * Let an overlay that portals to `document.body` keep its own scrolling when it
 * is opened from inside a Radix dialog (the mobile context sheet).
 *
 * Radix wraps dialog content in `RemoveScroll`, which registers non-passive
 * `wheel`/`touchmove` listeners on `document` and calls `preventDefault()` on
 * every event it does not own. It only recognises its own content subtree and
 * its `shards`; a sibling portal is neither, so the overlay renders fine but its
 * panes are frozen. Those listeners sit on `document` in the bubble phase, so
 * stopping propagation at the overlay root is enough to stay out of their reach.
 */
export function useScrollIsolation(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const isolate = (e: Event) => e.stopPropagation();
    node.addEventListener('wheel', isolate);
    node.addEventListener('touchmove', isolate);
    return () => {
      node.removeEventListener('wheel', isolate);
      node.removeEventListener('touchmove', isolate);
    };
  }, [ref]);
}
