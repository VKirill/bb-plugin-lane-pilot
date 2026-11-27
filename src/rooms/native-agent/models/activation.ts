export type ComposerKind = "new-thread" | "thread" | "queued-message" | "side-chat";

export type ActivationBlock = {
  code: "pending" | "need_project" | "need_binding" | "compiled_unsupported" | "no_projects" | "need_composer_selection";
  detail?: string;
};

export function activationDisabledPredicate(input: {
  pending?: boolean;
  projectId?: string | null;
  bindingStatus?: string | null;
  compiledRequested?: boolean;
  compiledSupported?: boolean;
  projectCount?: number;
  nativeSelectionReady?: boolean;
  launchMode?: "spawn" | "mention";
}): ActivationBlock[] {
  const blocks: ActivationBlock[] = [];
  if (input.pending) blocks.push({ code: "pending" });
  if (!input.projectId) {
    blocks.push({ code: input.projectCount === 0 ? "no_projects" : "need_project" });
  }
  if (input.launchMode !== "mention" && input.nativeSelectionReady !== true) {
    blocks.push({ code: "need_composer_selection" });
  }
  if (input.launchMode !== "mention" && (input.bindingStatus === "setup_required" || input.bindingStatus === "catalog_unavailable" || input.bindingStatus === "offline" || input.bindingStatus === "ambiguous")) {
    blocks.push({ code: "need_binding", detail: input.bindingStatus });
  }
  if (input.launchMode !== "mention" && input.compiledRequested && input.compiledSupported === false) {
    blocks.push({ code: "compiled_unsupported" });
  }
  return blocks;
}

export function composerButtonDisabled(blocks: ActivationBlock[]): boolean {
  return blocks.some((row) => row.code === "pending");
}

export function startBlocked(blocks: ActivationBlock[]): boolean {
  return blocks.length > 0;
}
