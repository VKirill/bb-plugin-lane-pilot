import { describe, expect, it } from "vitest";
import { collectQaArtifacts } from "../../src/rooms/qa/server/qa-artifacts";
import type { QaExpect } from "../../src/rooms/qa/server/qa-thread";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG_FILE = { content: PNG.toString("base64"), contentEncoding: "base64", sha256: "b".repeat(64), sizeBytes: PNG.length };
const expect1: QaExpect = { cases: [{ id: "c1", text: "one", login: null }], viewports: ["375"] };
const PASS_ROW = [{ id: "c1", viewport: "375", result: "passed" }];
const CLAIM = { case: "c1", viewport: "375", path: "artifacts/browser-qa/c1-375.png" };

function sdk(read: (args: { hostId: string; rootPath: string; path: string }) => Promise<typeof PNG_FILE> = async () => PNG_FILE) {
  return {
    threads: { storageLocation: async () => ({ hostId: "qa-host", storageRootPath: "/thread-store/thr" }) },
    files: { read: async (args: { hostId: string; rootPath: string; path: string }) => read(args) },
  };
}

describe("collectQaArtifacts", () => {
  it("verifies a claimed screenshot into a host-bound ref at the trusted absolute path", async () => {
    const reads: { hostId: string; rootPath: string; path: string }[] = [];
    const io = sdk(async (args) => { reads.push(args); return PNG_FILE; });
    const result = await collectQaArtifacts(io, "thr", expect1, PASS_ROW, [CLAIM]);
    expect(result.problems).toEqual([]);
    expect(reads).toEqual([{ hostId: "qa-host", rootPath: "/thread-store/thr",
      path: "/thread-store/thr/artifacts/browser-qa/c1-375.png" }]);
    expect(result.refs).toEqual([{ case: "c1", viewport: "375", hostId: "qa-host",
      path: "/thread-store/thr/artifacts/browser-qa/c1-375.png", sha256: "b".repeat(64), size: PNG.length }]);
  });

  it("requires evidence for every passed or failed pair and none for blocked", async () => {
    const missing = await collectQaArtifacts(sdk(), "thr", expect1, PASS_ROW, []);
    expect(missing.problems).toContain("missing_evidence:c1@375");
    const blocked = await collectQaArtifacts(sdk(), "thr", expect1, [{ id: "c1", viewport: "375", result: "blocked" }], []);
    expect(blocked.problems).toEqual([]);
  });

  it("rejects paths outside the artifact dir and basenames that disagree with the claim", async () => {
    for (const path of ["../c1-375.png", "artifacts/browser-qa/../c1-375.png", "/etc/c1-375.png",
      "artifacts/browser-qa/c2-375.png", "artifacts/browser-qa/c1-1280.png", "artifacts/browser-qa/c1-375.gif"]) {
      const result = await collectQaArtifacts(sdk(), "thr", expect1, PASS_ROW, [{ ...CLAIM, path }]);
      expect(result.problems.join(";")).toContain("artifact_path_invalid:c1@375");
      expect(result.refs).toEqual([]);
    }
  });

  it("fails unreadable, non-image and duplicated evidence with named reasons", async () => {
    const unreadable = await collectQaArtifacts(sdk(async () => { throw new Error("ENOENT"); }), "thr", expect1, PASS_ROW, [CLAIM]);
    expect(unreadable.problems).toContain("artifact_unreadable:c1@375");
    const textFile = { content: Buffer.from("not an image").toString("base64"), contentEncoding: "base64", sha256: "c".repeat(64), sizeBytes: 12 };
    const notImage = await collectQaArtifacts(sdk(async () => textFile), "thr", expect1, PASS_ROW, [CLAIM]);
    expect(notImage.problems.join(";")).toContain("artifact_not_image:c1@375");
    const doubled = await collectQaArtifacts(sdk(), "thr", expect1, PASS_ROW, [CLAIM, CLAIM]);
    expect(doubled.problems).toContain("duplicate_claim:c1@375");
    expect(doubled.refs).toHaveLength(1);
  });

  it("bounds the claim list", async () => {
    const claims = Array.from({ length: 101 }, (_, index) => ({ case: `c${index + 1}`, viewport: "375", path: `artifacts/browser-qa/c${index + 1}-375.png` }));
    const result = await collectQaArtifacts(sdk(), "thr", expect1, PASS_ROW, claims);
    expect(result.problems).toContain("artifact_claims_exceeded:101");
    expect(result.problems).toContain("unknown_claim_case:c2");
  });
});
