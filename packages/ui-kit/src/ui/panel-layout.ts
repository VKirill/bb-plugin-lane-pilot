import { createContext, useContext, useEffect, useState, type RefObject } from "react";

/** Plugin shell at or below this shows the mobile Select instead of the 13.5rem rail. */
export const SHELL_COMPACT_MAX = 448;
/** Form column at or below this stacks controls instead of a side-by-side row. */
export const CONTENT_STACK_MAX = 350;

export function chromeIsCompact(shellWidth: number): boolean {
  return shellWidth > 0 && shellWidth <= SHELL_COMPACT_MAX;
}

export function contentStacksControls(contentWidth: number): boolean {
  return contentWidth > 0 && contentWidth <= CONTENT_STACK_MAX;
}

export type PanelLayout = { compactChrome: boolean; stackControls: boolean };

export const PanelLayoutContext = createContext<PanelLayout>({ compactChrome: false, stackControls: false });

export function usePanelLayout(): PanelLayout {
  return useContext(PanelLayoutContext);
}

export function useObservedWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const apply = (next: number) => setWidth(next);
    apply(node.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (typeof next === "number") apply(next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
