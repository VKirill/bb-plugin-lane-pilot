# @lane-pilot/workflow-engine

The workflow engine without the plugin around it: the workflow schema and its validator, the expression language
(`expr`), lowering of `for_each`/`parallel` into the graph that runs, the engine with its journal, the router, the
reducers, the artifact kinds (`artifacts`), draft operations and the draft tester, the catalog of workflows, the view
that screens draw, and the stores that keep it all in SQLite or in files (`journal`, `store`, `ops-store`, `draft-store`,
`files`). `verdict` and `model-json` (the critic verdict shape and the clipping of model JSON) are here because the
engine's actions settle verdicts.

The built-in workflows (`workflows/*.json`, `src/rooms/workflow/builtin.ts`) are not in the package: `createWorkflowCatalog`
takes them as `builtin`. The database is a better-sqlite3 handle (`LanePilotDatabase` in `db.ts`).

`@lane-pilot/workflow-engine` is the whole API and imports `node:` modules (fs, crypto, os). The browser takes only
`@lane-pilot/workflow-engine/ui` (cron text, the draft view, edge labels, the view types), which has none.
Depends on `@lane-pilot/kit`, `models` and `contracts`; the workflow room, the storage room and the critique room use it.
