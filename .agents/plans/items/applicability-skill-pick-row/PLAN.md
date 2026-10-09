# Settings catalog test out of sync after writer.skill_pick

writer-skill-pick-v2 (commit c390253) added the setting `writer.skill_pick` to packages/settings-catalog/src/ui-catalog.ts. tests/applicability.test.ts now fails 4 checks:
- «matches settings.json 1:1 on area+setting+location+category»: 453 vs 452;
- «has a decision and path:line evidence on every row and counts match»: 453 vs 452;
- «documents the 355 source rows and native docs/onboarding additions…»: editable 231 vs 232;
- «keeps all former UI-visible fields on screen»: 323 vs 322.

Bring the applicability data in line with the new row, the same way earlier native additions were recorded. That means the applicability/settings JSON the test reads, with its decision and its path:line evidence pointing at the code that reads `writer.skill_pick`. Also update the expected counts in the test only where the test keeps literal totals. Check that the editable count mismatch (231 vs 232) is explained by the new row's category or control type, and fix the row if it was classified wrong. Do not drop the setting.

## Delivery
- [x] Recorded writer.skill_pick in the settings applicability data with decision and code evidence — accepted in run `lprun_3830fb02731046e89c6d9706ca217fd7`; merged as `d74c047`.
