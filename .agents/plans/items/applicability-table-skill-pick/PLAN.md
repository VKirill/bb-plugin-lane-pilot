# Add the writer.skill_pick row to the applicability table

The deploy gate fails on one test in tests/applicability.test.ts: «documents the 355 source rows and native docs/onboarding additions with location and path:line». The table rows in docs/adoc-applicability.md sum to editable 231. packages/settings-catalog/src/ui-catalog.summary.json says 232, because `writer.skill_pick` (catalog row s474, added by writer-skill-pick-v2) is in the catalog and the summary but has no row in the table.

## Do
1. Add a row for `writer.skill_pick` at the end of the table in docs/adoc-applicability.md, after the last native addition `workflow.preset.ins-digest.reasoning_effort`. Fill area, setting, location and category the same way as the other native writer rows. Set the decision to `editable`. The evidence must be a real path:line where the value is read, e.g. in src/rooms/writer/server/writer-skill-pick.ts or spawn.ts.
2. In tests/applicability.test.ts:
   - change `expect(rows).toHaveLength(452)` to 453;
   - append `"writer.skill_pick"` to the expected list of native additions, in the same order as the table;
   - make no other changes.
3. Run the whole file. If any other test in it now fails because of the new row (e.g. a 1:1 count against settings.json), fix it the same consistent way and say what you changed.

## Delivery
- [x] Added writer.skill_pick to the applicability table and updated the row-count coverage — accepted in run `lprun_3830fb02731046e89c6d9706ca217fd7`; merged as `b3f1d6f`.

docs/ is normally regenerated nightly. This table is a test fixture that is maintained by hand, so editing it is expected.
