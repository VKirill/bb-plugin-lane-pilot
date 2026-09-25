import { describe, expect, it } from "vitest";
import { nativeSelectionReady, readNativeComposerSelection } from "../src/composer-selection";
import type { ComposerView } from "@get-bb/plugin-sdk/app";

describe("native composer selection seam", () => {
  it("is unread until Luna's public reactive read is bound", () => {
    expect(readNativeComposerSelection({} as ComposerView)).toBeNull();
    expect(nativeSelectionReady(null)).toBe(false);
    expect(nativeSelectionReady({
      projectId: "proj_a",
      providerId: "openai",
      model: "gpt",
      environment: { kind: "local" },
    })).toBe(true);
  });
});
