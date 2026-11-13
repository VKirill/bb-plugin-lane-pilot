# Who runs a step, with what, on which model

Source: `src/server/workflow-agent.ts`, `workflow-agent-model.ts`, `workflow-executors.ts`, `src/helper-context.ts`, `src/workflow/model-presets.ts`, `model-catalog.ts`, `capabilities.ts` (`modelsSection`).

An `agent` step is a helper thread of the project's Lane Pilot PM chat: the profile of its `role`, the node's skills, plugins and MCP servers, its `prompt`, the data it was handed fenced as data, the role's method, and a typed answer (one fenced JSON block with the `out` fields and a non-empty `handoff`; one reminder in the same thread if the block is missing). It is read-only for the repository except where the role says otherwise; a changed file fails the step (`repo_edited`). Notes and scratch files go under `.bb/chats/` or `/tmp`.

## Roles

| role | reaches | use for |
|---|---|---|
| `analyst`, `planner`, `auditor`, `debugger` | repository read, code graph (gitnexus); a built-in method | reading code and judging; the planner writes task contracts, the auditor checks goals against evidence, the debugger finds a cause |
| `errand` | the owner's browser (`browser-automation`, `computer-use`), Env Catalog (`env_get` by name) | anything outside the code: signed-in sites, mail, consoles, a Telegram or mail send |
| `browser-qa` | `browser-automation` | a browser check of a URL against cases |
| `plan-critic`, `pm-reader`, `council`, `memory` | nothing: they answer from the message | judgments on supplied text |
| `code-critic`, `triager` | repository read, code graph | review of a diff, classifying failures |
| `project-life` | may write `.agents/` and `CHANGELOG.md` | project notes |
| `specialist:design-lead`, `:copy-lead`, `:seo-specialist`, `:tavily` | each specialist's skills; may write `.agents/` | design, copy, SEO, cited web research |

An unknown role, and the default `worker`, runs as `analyst`: no browser and no accounts. Pick the role by what the step must reach before you write its prompt. The owner can widen a role per project in Settings, "Agent access"; do not rely on it.

A step may add `skills`, `plugins` (BB plugin ids) and `mcp` (MCP server names), up to 8 each, on top of its role's. The session is spawned with exactly those added; plugins and MCP names are also checked by the preflight. Add only what the step uses: each one is loaded into the thread's context.

## The model of a step

Settings, not the graph, own the model by default. The first level that gives a complete provider+model pair is the base; the node's own `provider`, `model`, `reasoning`, `service_tier` then override field by field:

1. the node's `model_preset`;
2. the role's stage selection in the project's Settings: `analyst`, `pm-reader` use `pm_read`; `planner`, `plan-critic` use `plan_critique`; `code-critic` uses `code_critique`; `auditor` uses `code_critique`, then `night_review`; `debugger` uses `workflow.debugger`, then `specialist`; `specialist:*` use `specialist`;
3. `workflow.agent.*` (the generic selection for agent steps);
4. the model of the project's PM chat;
5. claude-code / claude-opus-5-5 / high when even that is unknown.

`lp-task` runs on the writer chain (`writer.*`, its fallbacks, then the PM's model), its code critic on `code_critique`. `decision`, `human` and code actions use no model. An action that goes through a helper (telegram.send_rich, shell.*, lp.preflight, lp.project_checks, deploy.post_check) is an `errand` step and takes `model_preset` too. The architect, the router's model step and the goal audit pick their own and do not come through here.

Presets are named settings `workflow.preset.<name>.{provider,model,reasoning_effort}`; the owner edits them in Settings, so a graph that names a preset follows a model change without an edit. Built-in defaults: `cheap-fast` (claude-haiku-5-5, low), `strong` (claude-opus-5-5, high), `ins-analysis`, `ins-psychology`, `ins-check`, `ins-digest` (the Insights pipeline). An unknown preset name is a warning and the step falls through to Settings; a known preset is used as it is, even when no machine offers its model (`offered: false` in the `models` section), and then the step fails to start, so do not name such a preset. How to choose: `cheap-fast` for collecting, extracting, scoring, formatting and sending; `strong` for judgment, planning and anything the owner reads as the product; nothing when the step is like the others. Set `provider` and `model` on a node only when the owner names them, as a pair.

### What the machines offer: the `models` section

`lane_pilot_workflow_draft {action: "capabilities", sections: ["models"], query: "opus"}` lists what the owner's machines offer: per provider the `machines` it runs on, its `serviceTiers`, and its `models` (`id` as a node writes it, `efforts`, `default`, and `only` when fewer machines have the model than the provider); `presets` resolved to the pair they run on now, with `offered` and the machines. Pick a pair only from there. A pair no machine offers is the validator warning `unknown_model` and the step fails to start. If the section is `unavailable`, no machine answered: name no pair, use a preset. The Models view of the Workflows tab shows the same catalog.

- `reasoning` is one of the model's `efforts`; the values the format accepts are `low|medium|high|xhigh|ultracode|max`, and `ultracode` exists only on models that list it.
- `service_tier` is `default` or `fast` (fast mode). Name `fast` only where the provider lists `serviceTiers`.
- The validator does not check `reasoning` against the model's efforts or `service_tier` against the provider; a wrong value is found at run time, so take both from the section.

### Coming, not in the code yet

A per-step model override for built-in graphs through the setting `workflow.model_override` is planned, with the precedence project, global, node, preset, role, `workflow.agent`, the PM chat. Until it ships (check `git grep model_override` in the plugin) nothing reads that setting: do not tell the owner it works, and keep to the order above.

## The browser

A step that must read signed-in pages or click: `role: errand`, skill `browser-automation` (persistent pages, snapshots, forms) or `computer-use` (one goal in the owner's Chrome through Jev); `requires.browserSession: true`; write the browser machine's id (the `browser` section of the capabilities) into the step's prompt, because `requires.machines` is shown to the owner and is neither checked nor passed to the step; for networks kept by `social-browser`, `requires.platforms`. Read-only unless the owner said otherwise. A login wall, rate limit or captcha is an enum status (`blocked`) with an edge to a `human` question or an `emit`, never a retry loop. A public search without a login: skill `tavily` (needs the Env Catalog name `TAVILY_API_KEY` in `requires.secrets`). `lane_pilot_helpers` with `action: "browser"` and `lane_pilot_errand` are the PM's tools; a graph step reaches the same browser through the skills.

## Secrets and accounts

Env Catalog names only: `requires.secrets: ["NAME", "OPTIONAL?"]`. The preflight checks the names exist; a missing one is requested from the owner with `env_request` (name, kind, purpose) as a masked form, never in chat. A step that needs the value is an `errand` step: it reads it by name with `env_get`, uses it for this job only, and prints it nowhere (not in its answer, a file or a screenshot note). Say in the prompt which name the step may read.

## Actions that have an executor

- Code, no model: `items.dedupe`, `dag.validate`, `digest.check`, `citations.check`, `verdict.aggregate`, `lp.propose_workflow`; `emit` ends the graph.
- Plugin state and the PM's checkout: `lp.state_probe`, `lp.run_status`, `lp.run_close`, `lp.lint_contract`, `lp.integration_gate_status` (answers `skipped` today), `fs.write`, `git.diff_files`.
- Through an `errand` helper with its skills and accounts: `telegram.send_rich`, `shell.skill_script` (a named script of a named skill, nothing else), `shell.repo_script`, `deploy.post_check`, `lp.preflight`, `lp.project_checks`. (`bb.tasks.*` is gone with the BB Tasks plugin, 0.1.236: the issue graphs take the issue as input.)

Any other name has no executor. The test runs it on stubs, publish lists it under `unregisteredExecutors`, and a live run stops at it. Mail, posts to other networks and the like have no action: an `errand` agent step with the skill that does it is the way, with the same approval and one-attempt rules as a send.
