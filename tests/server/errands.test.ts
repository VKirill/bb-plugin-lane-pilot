import { describe, expect, it } from "vitest";
import { errandPrompt, errandVerdict } from "../../src/rooms/qa/server/errands";

describe("errands", () => {
  it("lets a helper change things only when the owner asked for the change", () => {
    const readOnly = errandPrompt({ task: "Read the OAuth scopes", browserHostId: "host_mini", authorized: false });
    expect(readOnly).toContain("Read and report only");
    expect(readOnly).toContain("--machine host_mini");
    expect(readOnly).toContain("`ERRAND: done` or `ERRAND: blocked: <why>`");
    expect(readOnly).not.toContain("done | blocked");
    expect(errandPrompt({ task: "Remove the analytics scope", browserHostId: "host_mini", authorized: true })).toContain("Authorization follows the owner's goal");
    expect(errandPrompt({ task: "x".repeat(20), browserHostId: null, authorized: false })).toContain("No browser machine is set");
  });
});
