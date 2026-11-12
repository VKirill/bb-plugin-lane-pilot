import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { boundJevState, jevAsk, verifyDocsCitations } from "../src/rooms/docs/docs-jev";

afterEach(() => vi.unstubAllGlobals());

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
