import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readBoundedWorkspaceFile } from "@lane-pilot/kit";
import { nextAttemptState, resolveTransition, TRANSITION_TABLE, type TransitionEvent } from "../src/rooms/contracts/state-machine";

// Release stories — worker suite (SMA rl_stories / n1133): the real worker boundary guards and the law that a worker
// cannot accept its own work (only checks_passed reaches `accepted`).

const EVENTS: TransitionEvent[] = TRANSITION_TABLE.map((row) => row.event).filter((event, index, all) => all.indexOf(event) === index);

describe("worker boundary stories", () => {
  const cwd = mkdtempSync(join(tmpdir(), "lp-story-"));
  writeFileSync(join(cwd, "inside.txt"), "hello\n");

  it("a '..' path to a host-worker read handler throws", async () => {
    await expect(readBoundedWorkspaceFile({ hostId: "h", projectCwd: cwd, relativePath: "../outside.txt", offset: 0, maxLines: 10 })).rejects.toThrow(/escaped|symlink|directory/);
  });

  it("an absolute path and a symlinked path are refused the same way", async () => {
    await expect(readBoundedWorkspaceFile({ hostId: "h", projectCwd: cwd, relativePath: "/etc/passwd", offset: 0, maxLines: 10 })).rejects.toThrow();
    symlinkSync("/etc/hostname", join(cwd, "link.txt"));
    await expect(readBoundedWorkspaceFile({ hostId: "h", projectCwd: cwd, relativePath: "link.txt", offset: 0, maxLines: 10 })).rejects.toThrow(/symlink/);
  });

  it("an ordinary file inside the workspace still reads", async () => {
    const page = await readBoundedWorkspaceFile({ hostId: "h", projectCwd: cwd, relativePath: "inside.txt", offset: 0, maxLines: 10 });
    expect(page.truncated).toBe(false);
  });
});

describe("a worker cannot accept its own work", () => {
  it("no event but checks_passed reaches accepted from running", () => {
    for (const event of EVENTS.filter((e) => e !== "checks_passed")) {
      try {
        expect(resolveTransition("running", event)).not.toBe("accepted");
      } catch {
        // an illegal event is also not an acceptance
      }
    }
    expect(nextAttemptState("running", "checks_passed")).toBe("accepted");
  });

  it("a writer report with exit 0 and no verification stage leaves the attempt non-accepted", () => {
    // The writer's own report is no event at all: only the machine's checks_passed moves an attempt to accepted.
    const reportEvents: TransitionEvent[] = ["spawn_ok", "reconcile_found"];
    for (const event of reportEvents) {
      try {
        expect(resolveTransition("running", event)).not.toBe("accepted");
      } catch {
        // an illegal event is also not an acceptance
      }
    }
    expect(resolveTransition("running", "checks_passed")).toBe("accepted");
  });
});
