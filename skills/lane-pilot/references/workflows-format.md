# The format

Source: `src/workflow/schema.ts`, `validate.ts`, `docs/workflow-engine.md` sections 5 and 12. The schema is closed: an unknown key is an error. Write the authoring spelling below; it is normalized before validation.

## Workflow

`id` (lowercase, digits, `.`, `-`), `name` and `description` (`{en, ru}`; a plain string becomes both), `examples` (`{en: [], ru: []}`: how the owner would ask, the router matches on them), `not_for` (ids of neighbouring graphs or a phrase), `tags`, `inputs`, `outputs`, `requires`, `triggers`, `budget`, `guards`, `quality_mode`, `test`, `nodes`, `edges`. `status`, `version` and `scope` are set by publishing; do not set them.

Fields: `{name, type: string|number|boolean|enum|array|object|json, values (enum), required, default}`, or the short map `{topic: "string", mode: "fast|deep", items: "Item[]", note: "string?"}` (`a|b` is an enum, `T?` optional). Inputs are optional unless `required: true`; node outputs are required unless `required: false`.

## Nodes

Every runnable node: `id`, `title` (`{en, ru}`), `out`, `maxVisits`, `maxAttempts` (1-5, per visit), `timeoutSec` (or `guards: {timeoutMin}`), `with` (inputs of the node: `{{ref}}` templates), `reads`, `skip_when`, `skip_out`, `applicable_modes`.

| type | fields | notes |
|---|---|---|
| `agent` | `role`, `prompt`, `skills`, `plugins`, `mcp`, `model_preset`, `provider`, `model`, `reasoning`, `service_tier`, `session: new`, `votes`, `out` | A model thread; always also returns a non-empty `handoff`, and may return `outcome` (`done|partial|blocked|failed`, absent = done) with `blocker` (`{needs, from, fallback}`): the engine adds both unless `out` declares `outcome` or an enum containing `blocked`. With `blocked` or `failed` the other `out` fields may be left out and the run stops (`agent_blocked:<node>`, `agent_failed:<node>`). `environment` and `authorized` are accepted and read by nothing today. |
| `lp-task` | `owns_paths`, `contract` or `contract_template`, `quality_mode` | A repository change through the writer: critics, checks, merge. Never an agent that edits files. |
| `action` | `action`, `params` (other keys beside it are folded into `params`), `map` (emit) | Code, or an errand helper; see runtime. `action: emit` ends the graph. |
| `decision` | `reads_node` | Branches on fields already produced, no model. |
| `human` | `question`, `options` (up to 10), `onTimeout: stop|default`, `defaultOption` | A form in the project's Lane Pilot chat. `out` usually `answer` and an enum `answer_kind` (add `timeout` when the node has a timeout). |
| `parallel` | `for_each`, `batch_size`, `concurrency`, `max_fan_out`, `onOverflow`, `order: depends_on`, `on_child_fail`, `child`, `join` | `child` is an agent, lp-task, action or subworkflow body; `join {policy, out, uses}`. |
| `join` | `parallel`, `policy` | Only when the parallel has no `child` (its branches are its outgoing edges). |
| `subworkflow` | `workflow`, `version`, `inputs` | At most 3 levels, no recursion. |
| `note` | `text` | A comment on the canvas; never runs. |

`for_each` is a reference to a list (`dedupe.items`), a literal list, `ref where <condition on item>`, or `{by: "$inputs.tier", <value>: [...]}`. The default join concatenates arrays of the same name; anything else needs `join.uses` (a reducer that exists in `src/workflow/reducers.ts`; a reducer cannot be written from a chat, so use one the existing graphs have or compute in an action). `votes: N` on an agent child runs it N times and code decides (majority of a boolean, median of a number, most common scalar). `join.policy`: `all` fails at the first failed branch; `majority` and `all_or_low_confidence` let a failed branch arrive as failed.

## Edges

`from` (`start` begins the graph; exactly one entry edge), `to` (`end` or a node; every path ends in an `emit` node or an edge to `end`), `when`, `with`, `pass`, `label`.

- `with: {name: "node.field"}` or `"input.name"` (also `item`, `index`) hands data to the target. In mode `artifact` only the mapped fields arrive.
- `pass`: `artifact` (default), `same-session` (the target agent continues the source agent's thread: revisions and review loops), `read-prior-session` (a fresh agent reads the earlier handoff and judges independently). Anything but `artifact` needs an agent as the target. `fork` is accepted by the schema but nothing forks a session today: it behaves as `artifact`.
- A node has conditional edges plus at most one unconditional fallback. No edge matching fails the run (`no_matching_edge`); it is never a silent default.

## Expressions

In `when`, `skip_when`, `where` and value positions: `== != < <= > >= && || ! + -`, `in [...]`, `.length`, `visits('node')`, `$inputs.x`, `$mode`, `ctx.run_id|goal|merged_commits`, `item`, `index`, `node.field`. Checked at save: unknown field, an enum literal that can never match, a number compared with a string, a list compared with `==`. At run time a node that has not run fails the run (`condition_field_missing`). `{{slug}}`, `{{date}}`, `{{run_id}}` are run variables. `{by_mode: {quick, standard, full}}` in `with` picks by quality mode.

## Guards and budgets

- Loops: `maxVisits` (per scope) on a node of the cycle or `visits('n') < k` on an edge. A node without `maxVisits` may be visited any number of times; `guards.maxSteps` (default 60, at most 500) is the backstop.
- `maxAttempts` retries a step (at most 5); a step that sends something outside takes 1.
- `guards.maxFanOut` (default 12) caps branches; `budget {maxTokens, maxCostUsd, maxWallSeconds}` (or `max_minutes`, `max_usd`) blocks the run when exceeded (`budget_exceeded:<what>`); there is no step budget (loops are bounded by `maxVisits`), and `max_steps` is ignored. Set a budget on any graph that fans out or calls paid tools.

## Quality mode and skipping

`quality_mode` of the workflow `{default, effect, min, fixed}` (`quick` fewest review stages, `standard`, `full` adds the extra critics and the browser check); it matters for `lp-task` nodes and for `applicable_modes`. A node outside its `applicable_modes` or with a true `skip_when` is skipped and gives `skip_out`; a skippable node whose fields others read must declare `skip_out` (checked at save).

## requires

`skills`, `plugins`, `mcp`, `secrets` (Env Catalog names; `NAME?` optional), `tools` (commands on the machine: `ffmpeg`, `a|b`, `~/path/tool`), `platforms` (`threads`, `instagram`, `facebook`, `vk` are checked against the signed-in sessions; `x` cannot be checked), `machines`, `browserSession`, `env` (free text, shown not checked). The plugins and MCP servers named on agent steps are added to the check by themselves. A step's `skills` are only a hint to the step: list in `requires.skills` the ones the graph cannot work without.
