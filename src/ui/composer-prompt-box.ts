export const PROMPT_BOX_AGENT_LABEL_LEFT = "1rem";

export function findComposerPromptBox(from: Element | null): HTMLElement | null {
  if (!from) return null;
  const shell = from.closest("[data-promptbox-shell]");
  if (!shell) return null;
  return shell.querySelector("[data-promptbox]");
}

export function promptBoxFrameStyle(host: HTMLElement): {
  borderWidth: string;
  borderStyle: string;
  borderColor: string;
  backgroundColor: string;
  borderRadius: string;
} {
  const s = getComputedStyle(host);
  return {
    borderWidth: s.borderTopWidth,
    borderStyle: s.borderTopStyle,
    borderColor: s.borderTopColor,
    backgroundColor: s.backgroundColor,
    borderRadius: s.borderTopLeftRadius || host.style.borderRadius,
  };
}
