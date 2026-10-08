# @lane-pilot/jev

Jev (TypeSafe System One) as typed judgments: code finds candidates, Jev answers a typed question about them.

`createJevClient` (HTTP, budget, usage), `defineJudgment` / `choiceOf` / `noulOf` and the registry, thresholds
and modes (`off`, `shadow`, `active`), `createJev` (a judgment with its receipt in SQLite), `installJev` / `jev()` (the process-wide instance), and `output-guard` (the redaction and sampling before an output is
asked about). Three judgments that need nothing from the plugin are subpaths: `@lane-pilot/jev/judgments/output-guard`,
`invoice-check`, `repair-group`.

A judgment registers itself when its module is imported, so this package is not marked `sideEffects: false`.
The judgments tied to a room (`failure.class` in `runs`, `route.workflow` in `workflow`, the learning and
anamnesis ones) live in that room and are listed in `src/rooms/package.json`. Depends on `@lane-pilot/kit`.
