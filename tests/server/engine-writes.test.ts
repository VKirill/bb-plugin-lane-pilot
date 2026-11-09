import { describe, expect, it } from "vitest";
import { detectRepoEdits, noteEngineWrite, writtenByEngineSince } from "../../src/rooms/verification/server";

describe("files Lane Pilot's own graph actions wrote are not a helper's edit", () => {
  it("a parallel run's fs.write inside the helper's window is the engine's; one before the window or in another checkout is not", () => {
    const start = 1_000_000;
    noteEngineWrite("/repo/", ".agents/designs/idea-r1/guidance.md", start + 10);
    noteEngineWrite("/repo", "./early.md", start - 1);
    noteEngineWrite("/other", "x.md", start + 10);
    const own = writtenByEngineSince("/repo", start);
    expect([...own]).toEqual([".agents/designs/idea-r1/guidance.md"]);
    const changed = detectRepoEdits(new Set(), new Set([".agents/designs/idea-r1/guidance.md", "src/a.ts"]), () => false);
    expect(changed.filter((file) => !own.has(file))).toEqual(["src/a.ts"]);
  });

  it("forgets writes older than an hour", () => {
    noteEngineWrite("/old", "a.md", 0);
    noteEngineWrite("/old", "b.md", 2 * 60 * 60_000);
    expect([...writtenByEngineSince("/old", 0)]).toEqual(["b.md"]);
  });
});
