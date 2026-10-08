# @lane-pilot/contracts

The zod schemas that more than one room shares: `taskV2Schema` / `TaskV2`, `prototypeConfigSchema`, `settingValidationSchema`,
`installReceiptSchema`, the workflow view and draft result schemas, `modelCatalogSchema`, `HOST_JOB_KINDS`, and the stage
receipt contract (`stageReceiptSchema`, `STAGE_IDS`, `STAGE_STATES`, `validateStageReceipt`).

Schemas only: the RPC contracts themselves (`hostContract`, `rpcContract`) are assembled in `src/rooms/contracts`, because
they include the schedule and anamnesis fragments that live in those rooms. The index imports `@lane-pilot/kit` (node:),
so browser code takes types from `src/rooms/contracts` with `import type`. Depends on `@lane-pilot/kit`; anything may use it.
