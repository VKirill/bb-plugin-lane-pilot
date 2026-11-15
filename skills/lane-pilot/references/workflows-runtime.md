# Who runs a step, with what, on which model

Source: `src/rooms/workflow/server/workflow-agent.ts`, `workflow-executors.ts`, `src/rooms/contracts/helper-context.ts`, `packages/models/src/role-models.ts`, `capabilities.ts` (`modelsSection`).

An `agent` step is a helper thread of the project's Lane Pilot PM chat: the profile of its `role`, the node's skills, plugins and MCP servers, its `prompt`, the data it was handed fenced as data, the role's method, and a typed answer (one fenced JSON block with the `out` fields and a non-empty `handoff`; one reminder in the same thread if the block is missing). It is read-only for the repository except where the role says otherwise; a changed file fails the step (`repo_edited`). Notes and scratch files go under `.bb/chats/` or `/tmp`.

## Roles

| role | reaches | use for |
|---|---|---|
| `analyst`, `planner`, `auditor` | repository read via the provider's file tools; no MCP/code graph | reading code and judging; the planner writes task contracts and the auditor checks goals against evidence |
| `debugger`, `code-critic`, `specialist-reviewer` | repository read, code graph (GitNexus) | finding a cause, reviewing a diff, or specialist review |
| `errand` | the owner's browser (`browser-automation`, `computer-use`), Env Catalog (`env_get` by name) | anything outside the code: signed-in sites, mail, consoles, a Telegram or mail send |
| `browser-qa` | `browser-automation` | a browser check of a URL against cases |
| `plan-critic`, `pm-reader` | repository read via the provider's file tools; no MCP/code graph | plan and task reading |
| `council`, `memory` | nothing: they answer from the message | judgments on supplied text |
| `gate-triage` | no tools; answers from the supplied gate/check text | classifying failures |
| `project-life` | generic workflow role may write `.agents/**` and root `CHANGELOG.md` (workflow role guard) | standalone workflow project notes |
| `specialist:design-lead`, `:copy-lead`, `:seo-specialist`, `:tavily` | each specialist's skills; may write `.agents/` | design, copy, SEO, cited web research |

The `lp.project-life` action after acceptance is not a workflow role. Its stage guard allows `.agents/PROGRESS.md`, `.agents/CHANGELOG.md`, `.agents/plans/**` and `.agents/todos/**`; the normal stage path writes only `.agents/CHANGELOG.md` by script.

An unknown role, and the default `worker`, runs as `analyst`: no browser and no accounts. Pick the role by what the step must reach before you write its prompt. The owner can widen a role per project in Settings, "Agent access"; do not rely on it.

A step may add `skills`, `plugins` (BB plugin ids) and `mcp` (MCP server names), up to 8 each, on top of its role's. These names extend session access; plugins and MCP names are also checked by preflight. A skill allow-list is not evidence that its instructions were delivered or read. Node `skills` are hints; list indispensable skills in `requires.skills`. That check currently uses the project catalog, not a placed helper's environment. Add only capabilities the step needs. Explicit node skills are also resolved through provider command discovery in the actual helper workspace: Codex receives the resolved native skill mentions; Claude receives a mention only for one requested and resolved skill. Continued sessions use their own project, provider and environment. Unsupported providers, unverified workspaces and unresolved optional selections keep the original task prompt and emit a diagnostic. This requests skill selection; it does not prove that the provider loaded a particular skill body. Workflow-level requirements are not copied into every node.

## The model of a step

The model belongs to the role, not to the step: one table «role -> model» in the owner's Settings (project, section or global), the same in every graph (`docs/role-models.md`). Pick the `role` by the job and put no model on the node. `provider`, `model`, `reasoning`, `service_tier` and `model_preset` are accepted so older files load, change nothing when the step runs, and the validator warns `model_ignored`: remove them. A graph that needs another model asks the owner to change the role's row, or uses another role.

- A step resolves its role in this order, first hit wins: the owner's row `role_model.<role>`, a legacy stage selection (`plan_critique.*`, `specialist.*`), the role's built-in default, the role's fallback pair, the PM chat's model.
- `lp-task` runs on the writer chain (`writer.*`, its fallbacks, then the PM's model), its code critic on the `code-critic` row. `decision`, `human` and code actions use no model. An action that goes through a helper (telegram.send_rich, shell.*, lp.preflight, lp.project_checks, deploy.post_check) is an `errand` step.
- The architect, the router's model step and the goal audit pick their own and do not come through here.
- Which model a row has now: `lane_pilot_workflow_draft {action: "capabilities", sections: ["models"]}` (per provider the `machines`, `serviceTiers`, `models`). If the section is `unavailable`, no machine answered: name no model to the owner, say the table decides.

## The browser

A step that must read signed-in pages or click: `role: errand`, skill `browser-automation` (persistent pages, snapshots, forms) or `computer-use` (one goal in the owner's Chrome through agent-desktop); `requires.browserSession: true`; write the browser machine's id (the `browser` section of the capabilities) into the step's prompt, because `requires.machines` is shown to the owner and is neither checked nor passed to the step; for networks kept by `social-browser`, `requires.platforms`. Read-only unless the owner said otherwise. A login wall, rate limit or captcha is an enum status (`blocked`) with an edge to a `human` question or an `emit`, never a retry loop. A public search without a login: skill `tavily` (needs the Env Catalog name `TAVILY_API_KEY` in `requires.secrets`). `lane_pilot_helpers` with `action: "browser"` and `lane_pilot_errand` are the PM's tools; a graph step reaches the same browser through the skills.

## Secrets and accounts

Env Catalog names only: `requires.secrets: ["NAME", "OPTIONAL?"]`. The preflight checks the names exist; a missing one is requested from the owner with `env_request` (name, kind, purpose) as a masked form, never in chat. A step that needs the value is an `errand` step: it reads it by name with `env_get`, uses it for this job only, and prints it nowhere (not in its answer, a file or a screenshot note). Say in the prompt which name the step may read.

## Actions that have an executor

- Code, no model: `items.dedupe`, `dag.validate`, `digest.check`, `citations.check`, `verdict.aggregate`, `lp.propose_workflow`; `emit` ends the graph.
- Plugin state and the PM's checkout: `lp.state_probe`, `lp.run_status`, `lp.run_close`, `lp.lint_contract`, `lp.integration_gate_status` (answers `skipped` today), `fs.write`, `git.diff_files`.
- Through an `errand` helper with its skills and accounts: `telegram.send_rich`, `shell.skill_script` (a named script of a named skill, nothing else), `shell.repo_script`, `deploy.post_check`, `lp.preflight`, `lp.project_checks`. (`bb.tasks.*` is gone with the BB Tasks plugin, 0.1.236: the issue graphs take the issue as input.)

Any other name has no executor. The test runs it on stubs, publish lists it under `unregisteredExecutors`, and a live run stops at it. Mail, posts to other networks and the like have no action: an `errand` agent step with the skill that does it is the way, with the same approval and one-attempt rules as a send.
