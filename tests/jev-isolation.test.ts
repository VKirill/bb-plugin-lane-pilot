import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { classifyPlan } from "../src/rooms/host-worker/host-handlers";
import { boundJevState, jevAsk, jevCallFor, verifyDocsCitations } from "../src/rooms/verification/docs-jev";

afterEach(() => vi.unstubAllGlobals());

it("A-030 a concurrent host call must preserve the key/provider pair of the first call", async () => {
  const sent: Array<{ url: string; auth: string; task: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init: { headers: { authorization: string }; body: string }) => {
    sent.push({ url: String(url), auth: init.headers.authorization, task: JSON.parse(init.body).state.task });
    return new Response(JSON.stringify({ answers: { effort: { choice: "low" } } }));
  }));
  // The server puts the key on the call. Overlapping calls must not share one global pair. (2026-10-29 audit A-030)
  const a = classifyPlan({ requestedHostId: "fixture", plan: "project-a", jevApiKey: "fixture-openlux-a", jevProvider: "openlux" }, {} as never);
  const b = classifyPlan({ requestedHostId: "fixture", plan: "project-b", jevApiKey: "fixture-typesafe-b", jevProvider: "typesafe" }, {} as never);
  await Promise.all([a, b]);
  expect(sent.find((x) => x.task === "project-a"), JSON.stringify(sent)).toMatchObject({ url: "https://api.openlux.ai/v1/systemone", auth: "Bearer fixture-openlux-a" });
  expect(sent.find((x) => x.task === "project-b"), JSON.stringify(sent)).toMatchObject({ url: "https://api.typesafe.ai/v1/systemone", auth: "Bearer fixture-typesafe-b" });
});

it("A-030 an empty next request must not retain the preceding request credential", async () => {
  const sent: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: { headers: { authorization: string } }) => {
    sent.push(init.headers.authorization);
    return new Response(JSON.stringify({ answers: { effort: { choice: "low" } } }));
  }));
  const first = await jevCallFor({ jevApiKey: "fixture-previous-request", jevProvider: "openlux" });
  expect(first).toMatchObject({ key: "fixture-previous-request", provider: { id: "openlux", url: "https://api.openlux.ai/v1/systemone" } });
  await classifyPlan({ requestedHostId: "fixture", plan: "project-a", jevApiKey: "fixture-previous-request", jevProvider: "openlux" }, {} as never);
  await classifyPlan({ requestedHostId: "fixture", plan: "project-next" }, {} as never);
  expect(sent[0]).toBe("Bearer fixture-previous-request");
  expect(sent.slice(1).some((auth) => auth.includes("fixture-previous-request"))).toBe(false);
  expect((await jevCallFor())?.key ?? "").not.toBe("fixture-previous-request");
});

it("A-031 Jev state bound must actually bound a many-excerpt payload", () => {
  const state = { excerpts: Array.from({ length: 40 }, (_, i) => ({ file: `file-${i}.ts`, code: "x".repeat(8000) })) };
  const result = boundJevState(state, 100_000);
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(100_000);
});

it("A-031 citation verifier must not send an oversized many-source claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "audit-jev-size-"));
  try {
    const refs = Array.from({ length: 40 }, (_, i) => `file-${i}.ts:1`);
    await Promise.all(refs.map((ref, i) => writeFile(join(root, `file-${i}.ts`), `// ${String(i)}${"x".repeat(8000)}\n`)));
    const sizes: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: { body: string }) => {
      sizes.push(JSON.stringify(JSON.parse(init.body).state).length);
      return new Response(JSON.stringify({ answers: { support: { choice: "supported", probabilities: { supported: 1 } } } }));
    }));
    const result = await verifyDocsCitations({ projectCwd: root, jevApiKey: "fixture-size-only", jevProvider: "typesafe", pages: [{ path: "docs/claim.md", content: `These source modules implement the feature (${refs.join(", ")}).` }] });
    expect(result.checked).toBe(1);
    expect(sizes.length).toBe(1);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(100_000);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("A-031 a state with nothing to shrink is refused before fetch", async () => {
  const huge = { n: Array.from({ length: 20_000 }, (_, i) => i) };
  expect(() => boundJevState(huge)).toThrow(/over the limit of 100000/);
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  expect(await jevAsk("k", huge, { q: { type: "noul", instructions: "?" } })).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
