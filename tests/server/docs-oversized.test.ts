import { createHash } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../../server";
import { oversizedPageFindings } from "../../src/rooms/docs/docs-lint";
import { localDateKey } from "../../src/rooms/docs/docs";

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

const ev = (seq: number, type: string, data: Record<string, unknown> = {}, createdAt = 1_000) => ({ seq, type, createdAt, threadId:"thr_docs", data });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const BIG = "docs/adoc-applicability.md";
const overview = ["---", "title: Overview", "type: overview", "created: 2026-10-10", "updated: 2026-10-18", "status: active", "confidence: high",
  "tags: [overview]", "sources:", "  - server.ts", "---", "", "# Overview", "", "Entry (`server.ts:1`, `server.ts:2`, `server.ts:3`).", ""].join("\n");

/**
 * The root unit of Lane Pilot's pass on 2026-10-18 (thr_k9zs29ndm4), resumed after its writing turn: the agent edited
 * row 451 of the 129 KB adoc matrix, which was already over 40000 bytes on main, and the lint reads no oversized page.
 */
async function finish(oversizedAtStart: string[] | undefined) {
  const localDate = localDateKey(new Date()), sentAt = Date.now() - 600_000;
  const events = [ev(1, "client/turn/requested", {}, sentAt - 9_000), ev(2, "turn/started", {}, sentAt - 8_900),
    ev(3, "turn/completed", { status:"completed" }, sentAt - 500), ev(4, "client/turn/requested", {}, sentAt + 2_000),
    ev(5, "turn/started", {}, sentAt + 2_100), ev(6, "turn/completed", { status:"completed" }, sentAt + 30_000)].reverse();
  const calls: string[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId:"lane-pilot",
    sdk:{ threads:{ get:async () => ({ id:"thr_docs", status:"idle" }) as never, events:{ list:async () => events as never } } as never,
      files:{ read:async () => null } as never },
    experimental_callHostRpc:(call) => {
      calls.push(call.method);
      if (call.method === "gitDocsScope") return { hostId:"mb", status:"ready", isRepoRoot:true, hasDocs:true, changed:[], dirty:[BIG], base:"HEAD", workspaces:[], localDate, localHour:3, reason:null } as never;
      if (call.method === "listDocsPages") return { hostId:"mb", pages:[{ path:"docs/overview.md", modifiedAt:1, sha256:sha("o"), content:overview }], oversized:[BIG] } as never;
      if (call.method === "docsLineCounts") return { hostId:"mb", counts:{ "server.ts":200 } } as never;
      if (call.method === "writeDocsPages") return { hostId:"mb", previewSha256:sha("p"), status:"applied", writes:[], reason:null } as never;
      if (call.method === "gitCommitDocs") return { hostId:"mb", status:"committed", commit:"c0ffee", reason:null } as never;
      throw new Error(`unexpected host method ${call.method}`);
    },
  });
  await plugin(bb);
  dispose = () => harness.lifecycle.dispose();
  const place = "/Users/x/bb-plugin-lane-pilot";
  const key = `docs-unit:proj_lp:${createHash("sha256").update(`${place}\ndocs`).digest("hex").slice(0, 12)}`;
  await bb.storage.kv.set(key, { version:1, projectId:"proj_lp", place:{ hostId:"mb", path:place }, label:"docs", unit:{ docsDir:"docs" },
    threadId:"thr_docs", phase:"repairing", sentAt, beforeDirty:[], localDate, since:"7d", roots:["docs"], workspaces:[], hasDocs:true,
    changedCount:14, refresh:[], gaps:{ missingPages:[], uncoveredCore:[] }, anchors:null, core:[], kvKey:"docs-unit-report",
    ...(oversizedAtStart ? { oversizedAtStart } : {}) });
  await bb.storage.kv.set("docs-units-open", { [key]:true });
  await harness.runSchedule("docs-nightly-catchup");
  for (let tick = 0; tick < 200 && !await bb.storage.kv.get("docs-unit-report"); tick++) await new Promise((done) => setTimeout(done, 10));
  return { calls, row:await bb.storage.kv.get("docs-unit-report") as Record<string, unknown> | undefined };
}

describe("a docs page already over the size limit", () => {
  it("is reported, not held to a split, when the pass edits it; the pass commits", async () => {
    const { row, calls } = await finish([BIG]);
    expect(row?.state).toBe("passed");
    expect(row?.commit).toBe("c0ffee");
    expect(row?.warnings).toEqual([expect.objectContaining({ path:BIG, rule:"size" })]);
    expect(calls).toContain("gitCommitDocs");
  });

  it("still blocks the pass when this pass made the page oversized", async () => {
    const { row, calls } = await finish([]);
    expect(row?.state).toBe("failed");
    expect(row?.reason).toBe("1 docs checks still fail after one repair round");
    expect(calls).not.toContain("gitCommitDocs");
  });

  it("splits the oversized pages into blocking and reported by whether they were over the limit at the start", () => {
    const { blocking, kept } = oversizedPageFindings([BIG, "docs/data-model.md"], [BIG, "docs/gone.md"]);
    expect(blocking.map((finding) => finding.path)).toEqual(["docs/data-model.md"]);
    expect(kept.map((finding) => finding.path)).toEqual([BIG]);
  });
});
