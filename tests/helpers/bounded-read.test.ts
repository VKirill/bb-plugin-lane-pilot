import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBoundedWorkspaceFile } from "@lane-pilot/kit";
import { afterEach, describe, expect, it } from "vitest";
import { boundedReadReply } from "./bounded-read";

/**
 * Contract parity: the fixture mirror must return the exact reply the shipped
 * host primitive returns for the same bytes — same hash, line counts, offsets,
 * truncation. A drift here silently changes every read_first packet a fixture
 * produces, so the whole reply is compared, not selected fields.
 */
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function realReply(body: string, offset: number, maxLines: number) {
  const dir = mkdtempSync(join(tmpdir(), "lp-bounded-"));
  dirs.push(dir);
  writeFileSync(join(dir, "f.txt"), body, "utf8");
  return readBoundedWorkspaceFile({ hostId: "host-test", projectCwd: dir, relativePath: "f.txt", offset, maxLines });
}

const cases: Array<{ name: string; body: string; offset: number; maxLines: number }> = [
  { name: "empty file", body: "", offset: 0, maxLines: 10 },
  { name: "trailing LF", body: "alpha\nbeta\n", offset: 0, maxLines: 10 },
  { name: "CRLF and no trailing newline", body: "one\r\ntwo\r\nthree", offset: 0, maxLines: 10 },
  { name: "nonzero offset", body: "l1\nl2\nl3\nl4\n", offset: 1, maxLines: 2 },
  {
    name: "slice byte-cap boundary",
    body: `${"x".repeat(200 * 1024)}\n${"y".repeat(80 * 1024)}`,
    offset: 0,
    maxLines: 10,
  },
];

describe("boundedReadReply mirrors readBoundedWorkspaceFile", () => {
  for (const { name, body, offset, maxLines } of cases) {
    it(name, async () => {
      const real = await realReply(body, offset, maxLines);
      const mirrored = boundedReadReply({ hostId: "host-test", relativePath: "f.txt", offset, maxLines }, body);
      expect(mirrored).toEqual(real);
    });
  }
});
