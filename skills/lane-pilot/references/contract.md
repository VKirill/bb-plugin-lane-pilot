# Task contract

Contents: Lane Pilot contract rules · authoring checklist · Lane Pilot writer rules · schema-v2 fields · owns, dirt and caches.

> **Inside a Lane Pilot chat** (`LANE_PILOT_AGENT_TYPE` set / tools `lane_pilot_*` present) the contract is the task-v2 JSON in the `task` of `lane_pilot_dispatch_writer`. Its required fields are `schema_version`, `id`, `title`, `risk`, `lane`, `project_cwd`, `read_first`, `interfaces`, `invariants`, `out_of_scope`, `expected_outputs`, `owns_paths`, `never_touch`, `depends_on`, `objective`, `acceptance`, `verify`, and `verification`; valid optional fields are `skills`, `area`, `display_title`, `kind`, `quality_mode`, `qa_cases`, `qa_url`, `qa_env_class`, `qa_dev_server`, `convergence`, `files`, `appetite`, `forecast`, `wires`, `promise`, `priority`, `clarify`, `drawing`, `test_removals`, `fixes_regressions`, and `repo_scope`. Each `verification` item accepts `command`, `cwd`, optional `timeout_sec` (1–7200, default 900s), optional `secrets`, and optional `hidden`; any other field is rejected. The `plan` is the plan as text (a path is replaced by that file's text); Lane Pilot keeps it in the task's folder `.agents/tasks/<id>/PLAN.md`, so `read_first` names source files only: a path into another task's folder, into the shared `.agents/plans/*` or into another chat's `.bb/chats/` is refused. `depends_on` names tasks of this run and is the only ordering (a cycle or a self-dependency is refused at dispatch; the task starts once its dependencies are accepted and merged). A queued or blocked task is corrected in place with `lane_pilot_update_task` (a new contract edition and `PLAN.v<N>.md`). The writer's own notes (`QUESTIONS.md`, `CHECKPOINT.md`) go to its attempt folder in that home; Lane Pilot keeps them. The writer runs the supplied, non-hidden `verification` commands shown in its brief; hidden holdouts are omitted from that brief. Acceptance runs every declared verification item, including hidden holdouts, then checks the acceptance lines. Lane Pilot owns run state.

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

### Verification

- [ ] Commands are path-scoped unit/typecheck for **this** task  
- [ ] No bare monorepo `npm run build` / root `npm test` on multi-task runs (whole-suite checks belong to the batch integration gate)  
- [ ] **`timeout_sec` — omit unless > 900s is needed.** Runtime defaults to 900s  
- [ ] **Every script path in `verification[].command` exists on disk under `verification[].cwd` (or is created inside `owns_paths`)**  
- [ ] Prefer product tests (`tests/...`) inside `owns_paths` over ad-hoc `.agents/**` scripts  


### Acceptance

- [ ] Observable behavior, not “all packages green”  
- [ ] Matches objective; greps/sweeps named when deletion tasks  
- [ ] A task that adds a value or setting has a `verification` that follows it to its reader (setting → launch arguments), not only the computation  
- [ ] A change visible in a window has a `verification` that runs it (Playwright or equivalent); a run that did not happen is NOT RUN, never «no findings»  
- [ ] The task touches a shared mechanism (launch, isolation, config, the judge, a shared library) or its reach is unknown → `verification` covers everything that goes through it, not only the owned file's test  

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
| `verification` | Lane Pilot writer + acceptance | Focused commands; writer sees/runs only non-hidden items, acceptance runs all declared items | `[]` only with `verify: none` |
| `verify` | Task schema / Lane Pilot acceptance | `tests` / `smoke` / `none` describing the contract | do not invent a second suite |
| `depends_on` | DAG | Real compile/data ids | `[]` |
| `interfaces` | Prompt + path scrape | Signatures / type names | `[]` |
| `invariants` | Prompt | Product constraints | `[]` |
| `out_of_scope` | Prompt | Non-goals not already in `never_touch` | `[]` |
| `expected_outputs` | Schema + prompt | Artifact path this task creates | one path, not “typecheck green” |
| `skills` | PM hints / helper skills | Skill names the writer needs | omit when none |

No mutable `status` / free-form verify strings on new runs.

---

## Owns / dirt / caches

| Class | Policy |
|-------|--------|
| Pre-existing dirt outside owns | Foreign ignored (baseline / no-baseline policy) |
| New product files outside owns | **Fail** (writer leak or missing owns entry) |
| `.npm-cache`, `node_modules`, pnpm/yarn/turbo caches | **Ignored** by gate — never put in owns |
| `never_touch` hits (new) | **Fail** |

If owns fails with only cache paths: treat as control-plane noise, not “expand owns”.

