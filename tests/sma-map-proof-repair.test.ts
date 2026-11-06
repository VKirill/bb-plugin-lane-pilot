import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { brokenProof, proofDrift, fixProofsInFile } from "../src/rooms/sma-map";

const roots = { lanePilot: process.cwd() };

describe("proof repair after a move", () => {
  it("a moved anchor is red like a deleted one; --fix-proofs repairs only the moved", () => {
    // "acceptanceProofGap(provenBy)" exists in exactly one source file: a proof pointing anywhere else is a moved proof.
    const moved = "src/rooms/nowhere/gone.ts#acceptanceProofGap(provenBy)";
    const deleted = "src/rooms/nowhere/gone.ts#zzz-deleted-anchor-qq";
    expect(brokenProof(moved, roots)).toMatch(/no such file/);
    expect(brokenProof(deleted, roots)).toMatch(/no such file/);
    expect(proofDrift(moved, roots)).toMatch(/moved to /);
    expect(proofDrift(deleted, roots)).toBeNull();

    const file = join(mkdtempSync(join(tmpdir(), "sma-fix-")), "entries.ts");
    writeFileSync(file, `  n0: ["have", "d", ${JSON.stringify(moved)}],\n  n1: ["have", "d", ${JSON.stringify(deleted)}],\n`);
    const { fixed, unfixable } = fixProofsInFile(file, [moved, deleted], process.cwd());
    expect(unfixable).toEqual([deleted]);
    expect(fixed).toHaveLength(1);
    const written = readFileSync(file, "utf8");
    expect(brokenProof(fixed[0]!.to, roots)).toBeNull();
    expect(written).toContain(JSON.stringify(fixed[0]!.to));
    expect(written).toContain(deleted);
  });
});
