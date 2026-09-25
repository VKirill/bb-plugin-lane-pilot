import type { ComposerView } from "@get-bb/plugin-sdk/app";

export type NativeComposerSelection = {
  projectId: string | null;
  providerId: string;
  model: string;
  environment: unknown;
};

/**
 * Public reactive read of the new-thread composer selection.
 * Installed ComposerView has scope/layout/draft/run only.
 * experimental_setSelection is write+resolve, not get.
 * experimental_useCheckoutState is git state for a host/project you already know, not the composer pickers.
 * Luna's core seam replaces this body; do not add LP project/host pickers here.
 */
export function readNativeComposerSelection(_view: ComposerView): NativeComposerSelection | null {
  return null;
}

export function nativeSelectionReady(selection: NativeComposerSelection | null): boolean {
  return Boolean(selection?.providerId && selection.model && selection.environment != null);
}
