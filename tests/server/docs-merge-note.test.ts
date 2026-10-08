import { describe, expect, it } from "vitest";
import { createDocsNightly, docsMergeNote } from "../../src/server/docs-nightly";
import type { ServerCore } from "../../src/server/core";
import type { Services } from "../../src/server/services";
import { logIncidents } from "../../src/server/self-repair";

// treba-sites, 2026-10-07: the leftover docs worktree of 2026-10-06 met docs the owner had committed to main meanwhile.
const conflict = {
  status: "conflict",
  reason: "CONFLICT (add/add): Merge conflict in docs/gotchas.md\nAuto-merging docs/overview.md\nCONFLICT (add/add): Merge conflict in docs/overview.md\nAutomatic merge failed; fix conflicts and then commit the result.",
  conflicts: ["docs/gotchas.md", "docs/overview.md"],
};
const asLogLine = (note: { level: string; message: string }) => JSON.stringify({ ts: 2, level: note.level, message: note.message });

describe("docsMergeNote", () => {
  it("logs a leftover pass that conflicts with main as dropped, which the self-repair watcher does not take for a failure", () => {
    const note = docsMergeNote("/home/ubuntu/sites/treba-sites", conflict, true)!;
    expect(note.level).toBe("info");
    expect(note.message).toContain("dropped");
    expect(note.message).toContain("docs/gotchas.md, docs/overview.md");
    expect(logIncidents(asLogLine(note), 1)).toEqual([]);
  });

  it("still warns when this pass's own merge conflicts or fails", () => {
    const own = docsMergeNote("/srv/app", conflict)!;
    expect(own.level).toBe("warn");
    expect(logIncidents(asLogLine(own), 1)).toHaveLength(1);
    expect(docsMergeNote("/srv/app", { status: "failed", reason: "boom", conflicts: [] }, true)?.level).toBe("warn");
    expect(docsMergeNote("/srv/app", { status: "merged", conflicts: [] }, true)).toBeNull();
  });
});

describe("docs passes stopped by a plugin reload", () => {
  it("read the closed database and the stale handle as a stop, not a failure", () => {
    const { pluginStopped } = createDocsNightly({ bb: { background: { schedule: () => undefined } }, db: {}, host: {} } as unknown as ServerCore, {} as Services);
    // 2026-10-07 02:37 UTC, the 0.1.170 deploy reload: both lines came from passes in flight.
    expect(pluginStopped(new Error("The database connection is not open"))).toBe(true);
    expect(pluginStopped(new Error('plugin "lane-pilot" used a stale API handle — it was reloaded or disabled; re-entry happens via a fresh factory call'))).toBe(true);
    expect(pluginStopped(new Error("docs commit failed: nothing to commit"))).toBe(false);
  });
});
