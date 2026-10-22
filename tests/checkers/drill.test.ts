import { describe, expect, it } from "vitest";
import { renderDrill, runDrill } from "../../src/rooms/checkers/drill";
import { CODE_CHECKERS, DEFECT_CLASSES, EXPECTED_CATCHERS } from "../../src/rooms/checkers/types";

describe("checker drill", () => {
  it("is green on the fixture: every designed code catcher catches its planted defects and no code checker flags a clean candidate", async () => {
    const drill = await runDrill();
    expect(drill.problems).toEqual([]);
    expect(drill.ok).toBe(true);
    // Every class is planted at least once, and the class with a code catcher is caught by it.
    for (const row of drill.checked) {
      expect(row.planted, row.defectClass).toBeGreaterThan(0);
      for (const checker of EXPECTED_CATCHERS[row.defectClass as (typeof DEFECT_CLASSES)[number]]) {
        if ((CODE_CHECKERS as readonly string[]).includes(checker)) expect(row.caughtBy, `${row.defectClass} by ${checker}`).toContain(checker);
      }
    }
    expect(renderDrill(drill)).toContain("DRILL GREEN");
  }, 60_000);

  it("goes red when a checker stops catching its class (a blind checker, seen red on purpose)", async () => {
    for (const [blind, defectClass] of [["ownership", "outside_owns"], ["contract_lint", "masked_check"], ["plan_fact", "acceptance_missing"], ["verification", "broken_import"]] as const) {
      const drill = await runDrill({ blind: [blind] });
      expect(drill.ok, blind).toBe(false);
      expect(drill.problems.join("\n"), blind).toContain(`${blind} did not catch the planted defect`);
      expect(drill.problems.join("\n"), blind).toContain(defectClass);
      expect(renderDrill(drill)).toContain("DRILL RED");
    }
  }, 120_000);
});
