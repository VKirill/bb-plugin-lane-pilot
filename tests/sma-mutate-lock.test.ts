import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

// A second runner started while one is live must leave that run's mutated file and journal alone: restoring it
// mid-test makes the live run report a real test as `survived`.
test("sma-mutate: a second runner does not restore the file of a live run", () => {
  const root = resolve(__dirname, "..");
  const tmp = mkdtempSync(join(tmpdir(), "sma-mutate-lock-"));
  try {
    const state = join(tmp, "sma-mutate", createHash("sha256").update(root).digest("hex").slice(0, 12));
    mkdirSync(state, { recursive: true });
    const subject = join(tmp, "subject.ts");
    writeFileSync(subject, "mutated");
    writeFileSync(join(state, "backup"), "original");
    writeFileSync(join(state, "journal.json"), JSON.stringify({ file: subject }));
    writeFileSync(join(state, "lock"), String(process.pid)); // this test process is the live holder
    const run = spawnSync("node", [join(root, "scripts/sma-mutate.mjs"), "--dry", "--node", "n266"], {
      encoding: "utf8",
      env: { ...process.env, TMPDIR: tmp, SMA_MUTATE_TSX: "1" },
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("another sma-mutate");
    expect(readFileSync(subject, "utf8")).toBe("mutated");
    expect(existsSync(join(state, "journal.json"))).toBe(true);
    expect(readFileSync(join(state, "lock"), "utf8")).toBe(String(process.pid));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
