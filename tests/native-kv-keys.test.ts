import { expect, it } from "vitest";
import { nativeAgentTypeKey, nativeEnvKey, nativeSelectionKey, nativeThreadKey } from "../src/rooms/contracts/agent-ops";

// Pin the native lane KV keys: rows written by older builds carry these strings.
it("keeps the native lane KV keys byte-identical", () => {
  expect(nativeSelectionKey("tok")).toBe("native-selection:tok");
  expect(nativeThreadKey("thr_1")).toBe("native-thread:thr_1");
  expect(nativeEnvKey("thr_1")).toBe("native-env:thr_1");
  expect(nativeAgentTypeKey("thr_1")).toBe("native-agent-type:thr_1");
});
