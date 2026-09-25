import * as pluginApp from "@get-bb/plugin-sdk/app";
import type { ComposerSelectionSnapshot } from "../composer-selection";

function missingHookSnapshot(): ComposerSelectionSnapshot {
  return {
    status: "unsupported",
    scope: { kind: "new-thread", projectId: null },
    reason: "native-selection-unavailable",
  };
}

export function useNativeComposerSelection(): ComposerSelectionSnapshot {
  const hook = (pluginApp as { experimental_useComposerSelection?: () => ComposerSelectionSnapshot })
    .experimental_useComposerSelection;
  if (typeof hook !== "function") return missingHookSnapshot();
  try {
    return hook();
  } catch {
    return missingHookSnapshot();
  }
}
