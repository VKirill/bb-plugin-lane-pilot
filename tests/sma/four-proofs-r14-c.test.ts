// Region 14 · Memory, batch c (n1089 … n1117): behaviour tests of the four proofs. Every observation is made by tests/sma/r14-world-c.ts on the REAL code
// of this checkout (scratch database, scratch folders, no model, no hub write). Memory lives only on the hub: the cards that name a project file
// (the CLAUDE.md block, the .sma word index, the notes folder, the catalog) are proven on the hub path that serves their purpose.
import { describe, expect, it } from "vitest";
import { observe } from "./r14-world-c";

const REFUSAL = "memory content appears to contain a credential; no memory was saved";

describe("memory on the hub: the session block, twins, the pack, history, secrets (region 14, batch c)", () => {
  it("[sma:k_v_emit] [sma:k_lib_emit] the corpus block of a session is built from the hub's core records, newest first, within a budget, with the rule where to search and write; notes stay out, a Lane Pilot PM gets none, a new fact is in the next block, no project file is touched", async () => {
    const seen = await observe.block();
    expect(seen.head).toBe("Память проекта — факты:");
    expect(seen.bullets).toBeLessThan(10);
    expect(seen.bullets).toBeGreaterThan(0);
    expect(seen.hasNote).toBe(false);
    expect(seen.ruleAfter).toBe(true);
    expect(seen.pm).toBeNull();
    expect(seen.sameViaRpc).toBe(true);
    expect(seen.regeneratedHasFresh).toBe(true);
    expect(seen.freshFirst).toContain("A fresh convention written afterwards.");
    expect(seen.projectUntouched).toBe(true);
  });

  it("[sma:k_v_consolidate] twins merge at the write: the older wording is superseded by the newer one; one shared tag or a different fact stays; nothing waits as a proposal", () => {
    const seen = observe.consolidate();
    expect(seen.olderStatus).toBe("superseded");
    expect(seen.olderBy).toBe(true);
    expect(seen.oneSharedTagStays).toBe("active");
    expect(seen.differentStays).toBe("active");
    expect(seen.twinActive).toBe("active");
    expect(seen.activeAfter).toBe(3);
  });

  it("[sma:k_lib_contextpack] one query and one corpus give one pack, in the same order whatever the order the records came in; unrelated notes stay out", () => {
    const seen = observe.pack();
    expect(seen.identical).toBe(true);
    expect(seen.sameWhenShuffled).toBe(true);
    expect(seen.order).toEqual(["a-keep", "b-keep", "c-keep"]);
    expect(seen.unrelated).toBe(false);
  });

  it("[sma:k_lib_history] history is the hub's past tasks and notes: ten hits by default, more when asked, newest first, a secret masked, an unknown word finds nothing", () => {
    const seen = observe.history();
    expect(seen.defaultCount).toBe(10);
    expect(seen.wideCount).toBe(12);
    expect(seen.sources).toEqual(["lessons"]);
    expect(seen.newestFirst).toBe(true);
    expect(seen.masked).toBe(true);
    expect(seen.none).toBe(0);
  });

  it("[sma:k_lib_secretshapes] one list of secret shapes guards every record: a keyed password, an env key and a token are refused, an instruction override is refused with its own words, prose naming a variable stores; the import drops the token line only", () => {
    const seen = observe.secretShapes();
    for (const shape of [seen.keyed, seen.env, seen.jwt]) expect(shape).toBe(REFUSAL);
    expect(seen.override).toMatch(/instruction override/);
    expect(seen.prose).toBeNull();
    expect(seen.plain).toBeNull();
    expect(seen.importOutcomes).toEqual({ token: "dropped:secret", prose: "added:" });
    expect(seen.importRows).toBe(1);
  });

  it("[sma:k_lib_secretsmask] a stored secret never shows: the mask replaces a token with *** (or the given word), reports that it did, and leaves clean text alone", () => {
    const seen = observe.mask();
    expect(seen.hit).toEqual({ text: "deploy with *** now", masked: true });
    expect(seen.plain).toEqual({ text: "nothing secret here", masked: false });
    expect(seen.custom).toEqual({ text: "key [hidden]", masked: true });
    expect(seen.leaked).toBe(false);
  });

  it("[sma:k_lib_catalog] a file card is a pure function of the bytes and git facts: language, lines, first comment line, exports, last commit; changed bytes change the hash; a secret or binary file keeps name and size only; a token is masked", () => {
    const seen = observe.card();
    expect(seen.twice).toBe(true);
    expect(seen.first).toEqual({ lines: 6, language: "typescript", headLine: "Billing ledger helpers.", exports: ["LEDGER", "roundHalf"], lastCommit: "abc1234" });
    expect(seen.shaChanged).toBe(true);
    expect(seen.sameDerived).toBe(true);
    expect(seen.secret).toBe("secret");
    expect(seen.binary).toBe("binary");
    expect(seen.masked).toBe(true);
  });

  it("[sma:k_st_lexindex] the word index is a virtual FTS table on the hub, derived from the records: a deleted record leaves an orphan, a missing row is found by the check, the rebuild makes it whole", () => {
    const seen = observe.lexindex();
    expect(seen.virtual).toBe(true);
    expect(seen.built).toEqual({ active: 2, fts: 2 });
    expect(seen.drifted).toEqual({ missing: 1, orphaned: 1, orphanIsDeleted: true });
    expect(seen.check).toEqual({ active: 1, added: 1, stale: 1 });
    expect(seen.after).toEqual({ missing: 0, orphaned: 0, fts: 1, active: 1 });
  });

  it("[sma:k_st_usage] the ledger of loads is two columns of the record: a note given to a brief counts once per call and keeps the time; others, and another project's note named by mistake, stay at zero", () => {
    const seen = observe.usage();
    expect(seen.before).toEqual({ c: 0, at: null });
    expect(seen.a).toEqual({ c: 2, at: 2000 });
    expect(seen.b).toEqual({ c: 0, at: null });
    expect(seen.other).toEqual({ c: 0, at: null });
  });

  it("[sma:k_st_automem] no notes bypass the write pipeline: the launcher of a writer, an errand and a PM starts Claude with auto-memory off, whatever the caller passed, and keeps the other settings", () => {
    const seen = observe.autoMemory();
    expect(seen.writer).toBe(false);
    expect(seen.errand).toBe(false);
    expect(seen.pm).toBe(false);
    expect(seen.otherKept).toBe(false);
  });

  it("[sma:k_st_catalog] the catalog lives outside the project tree; the guard prints a file's card once per session before the file is changed, and nothing for a file with no card", () => {
    const seen = observe.guardCard();
    expect(seen.first).toBe(true);
    expect(seen.again).toBe(false);
    expect(seen.otherSession).toBe(true);
    expect(seen.uncarded).toBe(false);
    expect(seen.treeHasNoCatalog).toBe(true);
    expect(seen.catalogOutsideTree).toBe(true);
  });
});
