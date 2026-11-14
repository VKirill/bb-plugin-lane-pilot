# Task contract

Contents: orchestrator rules · authoring checklist · writer rules · schema-v2 fields · verification tiers · owns, dirt and caches.

> **Inside a Lane Pilot chat** (`LANE_PILOT_AGENT_TYPE` set / tools `lane_pilot_*` present) the contract is the task-v2 JSON in the `plan` of `lane_pilot_dispatch_writer`. Its required fields are `schema_version`, `id`, `title`, `risk`, `lane`, `project_cwd`, `read_first`, `interfaces`, `invariants`, `out_of_scope`, `expected_outputs`, `owns_paths`, `never_touch`, `depends_on`, `objective`, `acceptance`, `verify`, and `verification`; valid optional fields are `skills`, `area`, `display_title`, `kind`, `quality_mode`, `qa_cases`, `qa_url`, `qa_env_class`, `qa_dev_server`, `convergence`, `files`, `appetite`, `forecast`, `wires`, `promise`, `priority`, `clarify`, `drawing`, `test_removals`, `fixes_regressions`, and `repo_scope`. Each `verification` item accepts `command`, `cwd`, optional `timeout_sec` (1–7200), optional `secrets`, and optional `hidden`; any other field is rejected. `context_selectors` and `impact_*` are terminal Lane Stack fields, not Lane Pilot task fields. The `plan` is the plan as text (a path is replaced by that file's text); Lane Pilot keeps it in the task's folder `.agents/tasks/<id>/PLAN.md`, so `read_first` names source files only: a path into another task's folder, into the shared `.agents/plans/*` or into another chat's `.bb/chats/` is refused. `depends_on` names tasks of this run and is the only ordering (a cycle or a self-dependency is refused at dispatch; the task starts once its dependencies are accepted and merged). The writer's own notes (`QUESTIONS.md`, `CHECKPOINT.md`) go to its attempt folder in that home; Lane Pilot keeps them. The writer runs the supplied, non-hidden `verification` commands shown in its brief; hidden holdouts are omitted from that brief. Acceptance runs every declared verification item, including hidden holdouts, then checks the acceptance lines. Lane Pilot owns run state. The sections explicitly marked **terminal Lane Stack only** below do not govern an LP writer.


## Orchestrator must (terminal Lane Stack only)

1. `run-init` → fill PLAN/SPEC/tasks → `run-validate --phase pre-dispatch` before dispatch.  
2. Set **`owns_paths`**, **`never_touch`**, behavioral **`acceptance`**.  
3. **`read_first`**: existing project-relative files only. Line windows go in **`context_selectors`**. **`interfaces`**: signatures/types, or `[]`. Product **`invariants`** / **`out_of_scope`**; never writer recovery. **`expected_outputs`**: artifact path, not “tests green”.  
4. One `run-supervisor` per run; `lane-supervisor` only for typed one-shots.  
5. Parallel only with **disjoint** owns_paths.  
6. Controller: owns → L1 verify → accept **progressively**.  
7. Task YAML immutable after first start (in a Lane Pilot chat a queued or blocked task is corrected in place with `lane_pilot_update_task`: a new contract edition, a new `PLAN.v<N>.md`).  
8. Pre-merge validate → merge main (PM only).  
9. Writers via durable controller (kimi/…); Codex write = recovery only.  
10. Separate provider vs verification pools.  
11. **Decompose** per the orchestrator-lanes skill (decomposition) (one outcome per task; unlock ≠ feature).  
12. **SPEC.md** is real content when score ≥ 7 or ≥ 2 tasks (not the template stub).  

---

## Authoring checklist (before pre-dispatch)

### Decomposition

- [ ] Each task id has **one** product outcome  
- [ ] `depends_on` is a real compile/data edge, not narrative order, and the only ordering: do not encode order in wave numbers or plan text  
- [ ] Large delete vs new algorithm are **separate** tasks  
- [ ] Parallel tasks have disjoint owns  

### Owns completeness

- [ ] Every path the objective **requires** editing is listed (including companion modules the prompt forces — e.g. quality gates that still reference a removed field)  
- [ ] Package caches, `node_modules`, `.npm-cache`, build caches are **never** in owns  
- [ ] `never_touch` covers secrets, prisma (if frozen), unrelated products  

### Verification (terminal Lane Stack L1 only)

- [ ] Commands are path-scoped unit/typecheck for **this** task  
- [ ] No bare monorepo `npm run build` / root `npm test` on multi-task runs (that is L2)  
- [ ] **`timeout_sec` — omit.** Runtime defaults to 900s. Do not invent or bike-shed timeouts in plans  
- [ ] **Every script path in `verification[].command` exists on disk under `verification[].cwd` before pre-dispatch**  
- [ ] If `project_cwd` is a **worktree**: do **not** assume main-repo `.agents/runs/...` is visible — write/copy `check.py` into the worktree path **or** put tests under product `tests/` in owns; absolute paths to main are rejected  
- [ ] Prefer product tests (`tests/test_*.py`) over `.agents/**/check.py` when possible  
- [ ] PM **may** Write only basename `check.py` under `.agents/runs/<slug>/[artifacts/<id>/]` (guard allowlist); not other `.py`, not `state.json`/reports  


### Acceptance

- [ ] Observable behavior, not “all packages green”  
- [ ] Matches objective; greps/sweeps named when deletion tasks  
- [ ] A task that adds a value or setting has a `verification` that follows it to its reader (setting → launch arguments), not only the computation  
- [ ] A change visible in a window has a `verification` that runs it (Playwright or equivalent); a run that did not happen is NOT RUN, never «no findings»  
- [ ] The task touches a shared mechanism (launch, isolation, config, the judge, a shared library) or its reach is unknown → `verification` covers everything that goes through it, not only the owned file's test  

---

## Lane must (terminal Lane Stack writer only)

1. Read the complete raw task YAML supplied in the prompt; open TASK_FILE if absent or uncertain.
2. Work only in `PROJECT_CWD`.  
3. Edit **only** `owns_paths`. Honor `never_touch`.  
4. Do not write `.agents` (terminal harness rule).
5. Do **not** run tests/typecheck/`verification[]`; L1 is `lane-ctl verify`. Report in English.  
6. No git merge/push main.  
7. Outside-owns build break → report Gaps, do not “fix the world”.  
8. Do not run monorepo suites or Worker checks.  

---

## Lane Pilot writer must

1. Read the task contract, task-home manifest/brief, and the source files named by `read_first`.
2. Work in `project_cwd`; edit only `owns_paths` and honor `never_touch`.
3. Run every supplied, non-hidden command in `verification[]` and report its result; Lane Pilot runs every declared item, including hidden holdouts, at acceptance.
4. Put `QUESTIONS.md` and `CHECKPOINT.md` in the writer's own attempt folder under that task home. Do not edit shared project-level `.agents/` planning files or another task's home.
5. Do not merge or push main; report an outside-owns build break instead of broadening scope.

---

## Required schema-v2 task fields

Identity (must match adoc / run): `schema_version`, `id`, `title`, `risk`, `lane`, `project_cwd`.

| Field | What the machine uses | Fill | Leave empty / omit |
|-------|----------------------|------|-------------------|
| `objective` | Writer TZ (prompt) | One product outcome, behavior | never |
| `acceptance` | Report + PM | Observable behavior | never |
| `owns_paths` | Owns gate | Every path the outcome must edit | never |
| `never_touch` | Owns gate | Secrets / unrelated | `.env*` minimum |
| `read_first` | Packet files | Existing files, no notes | `[]` if none |
| `context_selectors` (terminal only) | Packet line windows | `{path, start_line, end_line}` | omit (do not put windows in `read_first`) |
| `verification` | Lane Pilot writer + acceptance; terminal L1 is separate below | Focused commands; writer sees/runs only non-hidden items, acceptance runs all declared items | `[]` only with `verify: none` |
| `verify` | Task schema / Lane Pilot acceptance | `tests` / `smoke` / `none` describing the contract | do not invent a second suite |
| `depends_on` | DAG | Real compile/data ids | `[]` |
| `interfaces` | Prompt + path scrape | Signatures / type names | `[]` |
| `invariants` | Prompt | Product constraints | `[]` |
| `out_of_scope` | Prompt | Non-goals not already in `never_touch` | `[]` |
| `expected_outputs` | Schema + prompt | Artifact path this task creates | one path, not “typecheck green” |
| `impact_receipt` / `impact_targets` (terminal only) | Packet | Only if you captured a receipt | omit |
| `skills` | PM hints / helper skills | Skill names the writer needs | omit when none |

`run-validate --phase pre-dispatch` (terminal Lane Stack only) rejects: `git checkout`/`restore` in the YAML; `read_first` prose (`section C4`, `lines 10-20`); missing `read_first` files; CONTINUATION / Gaps / HARD RULE / `wc -l` / edit-tool recovery in `interfaces` or `invariants`.

No mutable `status` / free-form verify strings on new runs.


---

## Verification tiers (terminal Lane Stack only)

| Tier | Who | What |
|------|-----|------|
| **L0** | Writer | Code + test files; do not execute runners |
| **L1** | `lane-ctl verify` | Task `verification[]` only |
| **L2** | PM / CI | One full or affected suite per run |

In Lane Pilot, the writer runs the supplied non-hidden checks; acceptance runs all `verification[]`, including hidden holdouts; the terminal L0/L1/L2 split above is not an LP writer instruction.

### Worktree + pre-authored checkers (terminal Lane Stack only)

`verification.cwd` must equal the task worktree/`project_cwd`. Relative scripts
resolve **inside that tree**. Main checkout `.agents/runs/<slug>/artifacts/001/check.py`
is **not** the same file as  
`worktree/.agents/runs/<slug>/artifacts/001/check.py`.

Pre-author the checker (recovery or PM, not the writer) under the worktree at the path the command uses, or use an in_place workspace.
`run-validate` fails closed if the script file is missing.


---

## Owns / dirt / caches

| Class | Policy |
|-------|--------|
| Pre-existing dirt outside owns | Foreign ignored (baseline / no-baseline policy) |
| New product files outside owns | **Fail** (writer leak or missing owns entry) |
| `.npm-cache`, `node_modules`, pnpm/yarn/turbo caches | **Ignored** by gate — never put in owns |
| `never_touch` hits (new) | **Fail** |

If owns fails with only cache paths: treat as control-plane noise, not “expand owns”.

