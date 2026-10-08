# @lane-pilot/settings-catalog

What the settings are: `ui-catalog` (the generated catalog, `UI_CATALOG`, `VISIBLE_CATALOG`; written by
`scripts/generate-ui-catalog.py` together with `ui-catalog.summary.json` and the field strings of `@lane-pilot/i18n`),
`channels` (the runtime channel of each key and why an unapplied one is unapplied), `lp-defaults`, `provider-pool`
(the per-provider writer cap) and `bookkeeping-paths` (files that are ownership noise).

No React, no SDK, no `node:` import: the page and the server read the same table. Depends on `@lane-pilot/kit`
(the owns-paths subpath only). The labels and the validation that need `t()` or Jev are in `src/rooms/settings`.
