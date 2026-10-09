# Family tools publish an empty schema (restart of family-tools-flat-schema; previous writer died on a gemini quota)

The earlier worktree of lpattempt_aaed6190f0fc4071ad9ac1ba526a3e5f may hold partial work; start from main.

## Evidence
- A PM called `lane_pilot_helpers {action:"browser_qa", taskId, url, viewports, cases}` → `Invalid arguments: runId: expected string`; `lane_pilot_relay {action:"remind", taskIds:"[...]", inMinutes:"60"}` → `note: expected string`.
- The schema agents receive through bb-bridge for every family tool is just `{"type":"object"}`. Cause: `mountFamily` in src/rooms/tools/server/tool-families.ts sets `parameters` to `z.discriminatedUnion("action", variants)`; its JSON Schema is a top-level oneOf/anyOf and the bridge keeps only `type: object`. Plain z.object tools (lane_pilot_dispatch_writer) arrive whole.

## Change
1. `mountFamily` publishes one flat `z.object`: `action: z.enum([...])` plus every field of every member tool, optional, merged by name (union of lenient types when names clash), each with `.describe()` saying which actions take it and where it is required. Keep `.strict()`. Note: zod shapes are readonly — build a new shape object, do not assign into `.shape`.
2. `execute` keeps per-action validation (`lenientArgs.get(action).parse(rest)` then `tool.parameters.parse`); other actions' fields refused; failures name the action and list missing required fields with types (e.g. `browser_qa needs: runId (string), envClass (local|staging|preview|production|unknown)`).
3. `familyInstructions` adds per action one generated line of required arguments, within INSTRUCTIONS_MAX.
4. `lane_pilot_browser_qa` instructions (tools.ts): `runId` is this PM's Lane Pilot run id (lprun_…, in the dynamic instructions and every dispatch/wait receipt); `envClass` says what the URL is (production for a live site).

## Tests (tests/pm-tool-families.test.ts)
Get family tools the same way existing tests in that file do (check how the harness registers them; `mountToolFamilies` must have run). Assert: each family's `z.toJSONSchema` has type object, `properties.action.enum` = actions, no top-level oneOf/anyOf; helpers has runId/envClass/cases/url, relay has note/taskIds/inMinutes; browser_qa without runId refused naming runId; valid calls still reach handlers incl. JSON-text numbers/lists; foreign fields refused.

## Delivery
- [x] Accepted in Lane Pilot run `lprun_987d16c051234cf4b4be09cff5817a86` on 2026-10-09.
