# Changelog

## 0.1.51 — 2026-10-02

- **The Council page fits a phone.** Below 640px the 16rem council list gave way to a select above the chat, so the chat no longer runs off the right edge. The question, seats and agenda take at most 40% of the height, and the seats and agenda fold away on a phone. Long words, code and tables wrap or scroll inside their message, and the composer puts its input on its own row. New messages scroll only the feed, not the BB page around it.

## 0.1.50 — 2026-10-02

- **The agent badge has small rounded corners, like the composer.** It copied the box's 14px radius, which made the 20px badge a pill; it now uses 6px.

## 0.1.49 — 2026-10-02

- **The agent badge no longer covers the placeholder in a collapsed composer.** On a phone the collapsed prompt box clips its overflow, so the badge was drawn inside it, over «Ask a follow-up». It now sits on the box's top border, as in the expanded composer.

## 0.1.48 — 2026-10-01

- **Analyzer threads say what they analyzed:** «Разбор ошибок · Клиенты / rich-tent.ru · 004.2, 007» and «Переписать правило · … · task ids», in the project's language, instead of «Lane Pilot rules: <category>».
- **Opening «Rules from lessons» no longer changes the analyzer.** The model picker reports a normalized value on mount; that was saved, which put SelfyStudio on GPT-6.1 Sol low instead of the GPT-6 Luna default. Only a change made by hand is saved now; SelfyStudio is back on Luna high fast.

## 0.1.47 — 2026-10-01

Rules analyzer prompts audited with the agent-instructions skill and measured before and after.

- **Evidence is fenced as data.** Writers' answers, failure reasons and reviews sit inside `<evidence>` / `<other_failures>` and the prompt says they are recorded output to analyze, not instructions, even where they address the analyzer: a rule written from them reaches every writer of the place.
- **«No rule» is a correct answer, and both costs are named.** A missing rule lets a mistake repeat; a wrong rule pushes every writer of the place the wrong way. System One's sort is presented as a guess to check, not a fact.
- **A rule is ready only when** it is one imperative sentence, an action inside the writer's own owns_paths and task, shown by the evidence to be skipped in at least two tasks, and specific to the project; each rule now carries `why`.
- **Rewrite may answer «no rule can help», and the rule is then retired** instead of staying as it was.
- Measured on GPT-6 Luna high and Grok 4.6, 3 runs per case, graded by code: Grok on the live SelfyStudio group (foreign failures) wrote a rule 3 of 3 times with the old prompt and 0 of 3 with the new one; injection held on both; Luna passed all four cases (foreign failures, missing outputs, injection, mixed) 12/12 with either prompt. The missing-output case uses synthetic writer answers because the original threads were deleted.

## 0.1.46 — 2026-10-01

- **The rules analyzer defaults to Codex GPT-6 Luna, high, fast** instead of the project's writer model; a model picked in «Rules from lessons» stays. On the live SelfyStudio group (three failed `npm -w` checks) Luna set all three aside as not the writers' fault (foreign specs, a file the writer never touched), while Grok 4.6 had written a rule telling writers to fix those failures, which would send them outside their owns_paths. Luna is also the cheaper model.
- The settings bundle builds again: 0.1.45 imported the docs default from a module that needs `node:crypto`.

## 0.1.45 — 2026-10-01

- **Docs are written by Codex GPT-6 Luna, high reasoning, fast tier by default**, not by the writer's model; a project that picks its own docs model keeps it. The nightly pass, the post-task stage and the settings picker use the same default.

## 0.1.44 — 2026-10-01

Memory on by default; docs kept automatically, only where a folder is worth it.

- **Project memory is on unless a project turns it off.** The maintainer runs after every accepted task and writers get relevant memory; adopted rules now reach writers in projects that never set memory (SelfyStudio among them). Projects that set it explicitly keep their choice.
- **Docs have three modes: Auto (default), Always, Never.** Projects that had docs switched on keep Always; unset ones are Auto. The settings switch is a select.
- **Auto judges every folder on every machine on its own.** The same section can be an advertiser's artifacts on one machine and working code on another. A host call reads what the folder is made of: code, test and content files, languages, package manifests, deploy files, the folder's own commits in 30 days, docs pages. Code settles the clear cases: not a git repository, no code, no commits and no docs yet → no docs; code with a package manifest, or 50+ code files → docs. System One judges the rest (scripts beside content without a manifest). The verdict is stored per machine and folder and asked again when the deciding facts move or after 30 days.
- **Docs nobody reads go quiet.** A task «reads» a folder's docs when its read_first or execution packet names a docs page. After 60 days without a read the folder's pass runs weekly (Mondays of its machine), after 120 days it pauses; a read brings it back to nightly.
- **One folder's docs pass at a time** across all projects: passes queue instead of running side by side.
- The post-task docs stage skips a folder Auto judged not worth docs. «Docs» lists every folder per machine with its verdict, reason, facts, cadence and last read, with «Re-evaluate».
- Calibrated on the owner's 65 folders on Mac mini and OVH: plugins, ohmy-seo, telegram-ads-assistant, SelfyStudio and treba keep docs; client, ads, SEO and paperwork folders are not repositories; muse and the landing templates have no code; treba-sites goes to System One (needed, 0.82).

## 0.1.43 — 2026-10-01

Rules learn on their own, inside the section they come from.

- **The system adopts the analyzer's rules on trial.** No button: a rule the analyzer writes goes into force at once, marked «on trial» (12 rules in force per project at most; over the cap it waits and the journal says why). Proposals the analyzer wrote earlier join on the next scan. Owner decisions are never touched by the trial.
- **A trial is judged by what happened to the writers who got the rule.** Counts come from what is already recorded, the attempt trace's picked rules and the triage's match of a failure to a rule, so nothing is counted twice: 5 attempts given the rule without the mistake confirm it; 2 writers given it repeating the mistake send it to the analyzer with those failures for a new wording (2 per scan at most); the same after the second wording retires it; a rule no task needed for 60 days leaves. A failure of a writer that was not given the rule does not count against it.
- **Every night.** At 03:30 each project with runs in the last 30 days rescans, adopts and judges, in the language of its last manual scan.
- **Rules stay in their section.** A writer mistake climbs the project's sections only as far as needed to reach three tasks: three in «Clients / rich-tent.ru» make a rule for rich-tent.ru alone, one each in three clients make a «Clients» rule, scattered ones a project rule. A writer gets only the rules of its own section and the sections above it, so one client's rule never reaches another client's writer; System One picks among those. Runs that did not record their sections are placed by their writer folder; failures match only rules of their own sections.
- Its migrations come after the triage migrations: the first build put them before and shifted a statement the hub had already applied, so the hub refused the reload and kept 0.1.42. A lineage test now pins the 62 statements the hub applied.
- **The block shows the trial.** Each rule says its section, who adopted it, on trial or confirmed, the wording number, how many writers got it and how many repeated the mistake anyway; a journal lists every adoption, confirmation, rewrite and retirement with its reason. The owner can still revoke any rule.

## 0.1.42 — 2026-10-01

- **Lane Pilot can be enabled from a chat again.** BB 0.5 rejects `sourceThreadId` on a spawn that is not a fork («sourceThreadId requires an originKind»), and the PM was spawned with it, so «Enable Lane Pilot» from an ordinary chat and `bb lane-pilot activate` failed. The PM is now the chat's child without a source; writer placement takes the PM's parent as its source when BB stores none (helpers already dropped the field). Found by the live sandbox check of 0.1.41.

## 0.1.41 — 2026-10-01

- **A writer reads only the rules its task needs.** Before a writer starts, System One gets the task contract (objective, paths, acceptance, interfaces, invariants, verification commands) and one yes/no question per accepted rule; a rule goes into the prompt from p(yes) 0.3 up. Without an answer every rule goes in, as before: a missing rule costs more than an extra one. Calibrated on 60 SelfyStudio contracts with the analyzer's live rule and a deploy rule: 2 of 59 needed rules missed, 4 of 61 unneeded added; without interfaces and invariants terse release tasks («Ship 6ce641636b») were missed. The attempt trace records which rules were picked out of how many (`dispatchContext.rulesPicked`).

## 0.1.40 — 2026-10-01

- **Text-grouping drafts leave once Jev answers.** A scan that reached System One deletes the fallback's undecided `sweep` proposals; decided ones stay, and the fallback recreates drafts only when Jev is unavailable. On the hub the two 0.1.37 drafts (bookkeeping noise in 40 and 11 SelfyStudio tasks) were still waiting for the owner next to the analyzer's rule.

## 0.1.39 — 2026-10-01

Fixes from the first live scan on the hub (SelfyStudio, 45 failures).

- **Code decides ownership rejections it can judge.** Jev called 26 SelfyStudio failures the writer's fault; 20 of them were ownership rejections of paths the task itself owns, the sibling never_touch union fixed in 0.1.24. Rejected paths are now split into owned, bookkeeping and outside the task's scope with Lane Pilot's own glob rules: a gate that rejected owned or only bookkeeping paths is Lane Pilot's fault without asking Jev, and Jev sees only the paths really outside the task. Over all 103 hub failures of 30 days: 56 decided in code, 12 writer mistakes left (missing expected files, broken project tests, an unowned test file), each checked by hand.
- **Stored answers are versioned.** Changing facts, questions or code verdicts re-asks every stored answer once.
- **A scan cut off by a restart is reported as interrupted** instead of staying «running» with the button locked (the hub's BB server restarted 23 s into the first scan).

## 0.1.38 — 2026-10-01

Rules from lessons now come from sorting by meaning instead of masked failure text. The 0.1.37 grouping proposed Lane Pilot's own old bug (bookkeeping files counted against writers) as a writer rule.

- **System One sorts every failed writer attempt.** One Jev call per attempt through the project's machine (`councilJudge`) answers whose fault it is (writer, Lane Pilot, environment, task contract, unclear), what kind of writer mistake it is, and whether an existing rule already covers it. Code computes the facts Jev needs (bookkeeping-only paths, internal error codes, prose expected outputs). Answers are stored per attempt and reused until the failure text changes; new failures of active projects are sorted every 15 minutes.
- **Calibrated before use.** On 35 labelled hub failures writer-or-not came out 35/35 in two runs and the category 7/7; the five-way origin is about 74 % and is shown as information only.
- **The analyzer model writes the rules.** «Rescan» in «Rules from lessons» sorts the last 30 days, then for every category with writer mistakes in at least three tasks a hidden thread on the chosen analyzer model reads the task contracts, failure reasons, critiques and the tail of each writer's answer and writes up to three rules citing task ids. It also lists where else the same mistake happened and drops failures that are not the writer's. The analyzer model has its own picker in the block, the project's writer by default.
- **Evidence on every proposal.** A proposal shows the tasks it stands on; tasks already cited, matched to a rule or set aside by the analyzer are not proposed again, so a second scan costs nothing when nothing new failed.
- Without Jev on the project's machine the scan falls back to the 0.1.37 text grouping, which now also leaves out rejections that name only `.agents/`, `.bb/`, `.claude/` or `PROGRESS.md`.

## 0.1.37 — 2026-10-01

Two ideas from the «Harness and Loop Engineering» write-up (thread thr_58hvcw4qtg): a loop needs a hard exit when a task cannot be done, and lessons should turn into rules a human confirms.

- **A writer can stop and ask.** When the contract contradicts itself or the code, or a file, access or product decision it needs is missing, the writer answers `NEEDS_HUMAN: <question>` and changes nothing. The attempt ends `blocked` with `needs_human: <question>` at once: no second attempt, no emergency writer, and the PM is told to put the question to the owner. Before, such a task burned two attempts and ended as «retry limit 2 exhausted».
- **Repeated lessons become rule proposals.** A writer failure with the same shape in at least three tasks over 30 days (paths, numbers and hosts masked; one task counts once however many stages recorded it) becomes a proposal. Failures of the run machinery (`internal_error`, worktree provisioning, execution packets, merge conflicts) and plan critiques are left out: no writer rule can prevent them. The PM can reword a proposal with `lane_pilot_rule_propose`; `lane_pilot_lessons_sweep` lists the waiting ones.
- **The owner decides in settings.** «Memory and docs» gets «Rules from lessons»: edit the wording, accept or reject; accepted rules can be revoked. An accepted rule is a `core` project memory record for writers (CLI export marks it `always`), and every writer prompt carries the rules in force in their own block, repair prompts included. Revoking removes the record.
- **Lessons see validation failures.** `collectLessonSources` read only `failed`, `blocked` and `rejected` attempts, while most real rejections end in `validation_failed` and `blocked` carries «retry limit exhausted», which is filtered as noise. On the hub that left 50+ ownership rejections out of lessons.
- Not done on purpose: running checks only for changed modules. On the hub 11 of about 130 failed attempts in 10 days failed a verification command, and nearly all of those were the environment (no network in the sandbox, `bb` missing, `false`).

## 0.1.36 — 2026-10-01

- **One broken machine no longer takes Lane Pilot down.** With core lifecycle support back on the hub (0.44.0-vk.3), every load runs `enable` on each registered machine to repair Claude Lane. The MacBook's Codex CLI was broken (missing `@openai/codex-darwin-arm64`), its `nativeInstall` failed, and the whole plugin failed to load on every machine. Enable and disable now carry on past a failing machine and keep its error under `native-install:error:<host>`, cleared by the next success; removal stays strict so files are never left orphaned.
- Tests: the page-mounting UI file gets a 20 s budget (each test mounts the settings page, 1–3 s alone); the hourly docs test holds the docs child explicitly instead of relying on being the first to poll it. Three full runs green in a row.

## 0.1.35 — 2026-10-01

The suite is green for the first time since the server split: 915 passed, 0 failed (27 failed on 0.1.34), `tsc` clean (6 errors before). Two production bugs surfaced while fixing it.

- **A PM started without a source thread can dispatch writers again.** Every helper spawn (writer, critic, council turn) needs the parent's source and lifecycle owner; a root `bb` PM — Enable without a source chat — has neither, so each writer spawn failed with `helper_parent_relation_missing` (hub log, 2026-09-27, 8 rejected attempts). A root PM thread is now its own source and owner, as a native CLI root chat already was.
- **A repaired revision is re-critiqued.** After a repair the new code-critique row inherited the repair ledger's `spawnAttempted`, so `claimStageSpawn` refused, the old critic thread was adopted and its previous `changes_requested` re-read: the repair was never reviewed and the task ended blocked.
- **The real spawn error survives reconcile.** A rejected spawn used to read only «reconcile completed on a short page without a matching thread», which hid the cause above for days; the original error now leads the reason.
- **Git arguments are parsed, not grepped.** The guard reads `git commit/push/merge` arguments with shlex, so a commit message that mentions forced pushes or the hook-skip flag is text; `git push -uf` and `git push origin +main` are now caught.
- **Tests no longer depend on another chat's temp folder or on machine state.** Upstream comparisons use a pinned Claude Lane Stack v1.38.0 (`tests/upstream-fixture.ts`: env, legacy snapshot, cached `git archive` of the pinned commit from the sibling checkout, or a clear skip). The npm-isolation test checks that a run leaves the host's global npm unchanged instead of requiring it to be empty. Stale tests follow the current contracts: worktree merge via `gitIntegrate`, execution packets that name files and line windows, background memory after acceptance, the native installer, current error texts. A page-mounting UI test runs one scenario per test instead of five mounts in one 5 s budget.
- Type fixes: `collectAgentInventory` lists skills only with a project id; managed-workspace binding falls back to the configured host explicitly.

## 0.1.34 — 2026-10-01

Instructions audit against Anthropic's «Prompting playbook» (thread thr_syz25bgrhk).

- **The PM ships the way the project runs.** «Ship» no longer hinges on `scripts/deploy.sh`: after every task is accepted the PM pushes main to origin (never force), brings the project up by its own deploy or start command (PROJECT.md, README, package scripts, deploy script, docker compose, systemd) and proves it is live with a healthcheck or a request; with no way to run the project it says so after the push. The PM prompt now ends with a done criterion.
- **A denied PM edit points to `lane_pilot_dispatch_writer`.** In a Lane Pilot chat the guard used to answer «delegate mutations to the run supervisor», an agent the PM prompt forbids and Lane Pilot strips. The terminal orchestrator keeps the old route.
- **`wt-merge-main` and `run-init` are blocked by the guard in a Lane Pilot chat**, not only by the prompt: Lane Pilot merges accepted work itself. Read-only `run-validate` stays allowed and the prompt no longer forbids it.
- **Project git hooks run on writer commits.** `integrateWorktree` committed the writer's worktree with the hook-skip flag, while the merge into main ran hooks and the guard forbids that flag to agents. A rejecting hook now fails the attempt with the hook's output, and the retry has to satisfy it.
- **The guard reads commands, not report text.** Destructive checks (hook skip, force push, DROP/TRUNCATE, DELETE without WHERE, recursive force delete) skip heredoc bodies handed to a non-shell program; a heredoc piped or fed to a shell is still checked. Force-push flags are read inside the `git push` command and case-sensitively: `git commit -F msg && git push` was denied as a force push; `+refspec` now counts as forced.
- **Rules carry their reasons.** One docs rule with its reason («Lane Pilot writes docs nightly and reverts other edits») for every session; reasons for the PM's autonomy, the shell-edit ban and the specialists' former bare prohibitions; the list of agents the PM may not spawn is gone because code already strips them.
- **Handoff recipients are described.** The registry showed only each agent's «You are **x**» header; every agent now has a one-line summary of what it does and leaves to others, used for listing and for picking a recipient by request.
- **Night review blocks only on real defects**: a concrete unmet requirement, broken behavior, a security or data-loss risk; style is a warning at most.

## 0.1.33 — 2026-09-30

- The chair's decision no longer fails on an over-long field: strings are clipped to the schema ceilings with an ellipsis. A live session had failed on a 300-character metric.
- A council interrupted by a plugin reload is marked failed with the reason instead of staying «in session» forever; `bb lane-pilot council-seats <project>` shows the pair every seat would get and the pairs the stage selections offer.

## 0.1.32 — 2026-09-30

- **Council seats no longer save a model by themselves.** The settings panel shows which pair each seat would take from the stage selections; a picker appears only after «Задать свою модель», and «Вернуть наследование» drops the seat back. The earlier version let the picker report the catalog's first model as a choice for every empty seat.

## 0.1.31 — 2026-09-30

- **The judge is visible and weighed.** Every time a seat gets the floor the feed records why and by whom (Jev or the rule) with every seat's impulse score. Jev's confidence now weighs the impulse: a hesitant «evidence» stays below the floor threshold, a sure «addressed» passes. Verified against System One from the OVH host with real council states.

## 0.1.30 — 2026-09-30

- **Directors read the code.** Every seat and the chair already ran inside the project checkout with tools; now their prompt says so: read files, grep, run read-only commands and cite path:line before claiming anything, and never modify, install, commit or start anything. Each role has a lens, where it looks first (product: screens and flows; demand: request data and analytics; audience: copy and onboarding; skeptic: validation, billing, tests; growth: funnel and payments; ux: components and states).

## 0.1.29 — 2026-09-30

- **Council seats in settings.** The «Совет директоров» group on the project settings panel has one provider/model/reasoning picker per seat (product, demand, audience, skeptic, growth, ux) and for the chair, drawn from the live BB catalog, so an OpenRouter model, a local one or any other configured provider can sit at the table. Empty seats keep taking distinct pairs from the stage selections. The group also holds «Jev судит совет» and the number of laps.
- **The council page renders Markdown** (statements come with headings, code and lists) and shows session states in plain words.

## 0.1.28 — 2026-09-30

- **The boardroom.** A council now runs as a room by default: after every seat's opening position, seats speak when they have something to add, not in turn. After each message every seat's impulse is judged (Jev through the host's `councilJudge`, or the built-in rule: an addressed seat must answer, the owner's words wake everyone, a seat silent for a full lap gets the floor, the last speaker waits), one seat gets the floor, and a moderator verdict ends the discussion when the room repeats itself. The owner joins at any time with `lane_pilot_council_say` (or the RPC behind the page), names a seat to make it answer next, and asks for the decision with `decide`. `mode: "rounds"` keeps the fixed-round debate.
- **A council page in the sidebar.** «Совет» shows every council of a project as a chat: seats with their models, the agenda, the live feed with who is writing, the owner's composer, «Решать» and «Стоп».
- **Jev is the judge.** The host handler `councilJudge` asks System One several choice questions over a JSON state; the council uses it for the moderator and the seats' impulse, and falls back to the rule when the key is missing or the call fails.
- **Run budgets on the settings panel.** `run.max_attempts`, `run.max_wall_minutes`, `run.max_tokens`, `run.max_children` are catalog rows in the ops section with EN/RU labels; empty means no limit.

## 0.1.27 — 2026-09-30

- **Council of directors.** `lane_pilot_council_start` convenes role-bound seats (product, demand, audience, skeptic; growth and ux on request) on distinct configured models as hidden threads. The chair turns the question into an agenda and criteria, seats give positions and reply only where they disagree or add evidence (PASS otherwise), a moderator rule ends the discussion on the round cap, on repetition or when most seats pass (an outside judge can override), and the chair writes a decision record: options ranked by the criteria, recommendation, dissent, experiments, next tasks. The record lands in `docs/decisions/` and each next task becomes a handoff card. `lane_pilot_council_status` and the run monitor show the feed; `lane_pilot_council_stop` ends a session. Package `@lane-pilot/council` holds the protocol.

## 0.1.26 — 2026-09-30

- **Packages.** An npm workspace under `packages/` holds code reusable beyond this plugin: `@lane-pilot/thread-observe` (when a child thread is done or failed), `@lane-pilot/memory-core` (guarded project memory over SQLite), `@lane-pilot/handoff` (typed task cards between agents with states, leases and receipts), `@lane-pilot/resilience` (provider circuit breaker, run budgets), `@lane-pilot/run-insights` (writer acceptance per model and risk, lessons from receipts, golden retrieval checks). The map and the rules are in [docs/architecture.md](docs/architecture.md).
- **Handoffs.** PM tools `lane_pilot_handoff_create`, `lane_pilot_handoff_receipt`, `lane_pilot_handoff_list`: a task given to another agent is a card with objective, acceptance, inputs, budget and deadline; it is delivered into a named BB thread or carried to the caller's own subagent, and its receipt closes it. Overdue cards expire every five minutes.
- **Learning loop.** `lane_pilot_lessons_sweep` and a quarter-hourly schedule turn night review findings, rejected acceptances and failed attempts into `subagent` memory notes that the next writer in the same area reads; `lane_pilot_memory_golden` scores retrieval against a golden set; `lane_pilot_routing_stats` shows which provider and model gets tasks accepted at the first try per risk and hints against the configured writer.
- **Writers fail over and stay within budget.** A provider/model that fails repeatedly opens a breaker; the next writer is rejected as unavailable and the existing emergency fallback takes over. A run budget over attempts, wall minutes, tokens and child threads (`bb lane-pilot budget <project> run.max_tokens=...`) blocks new attempts with the exact reason. `lane_pilot_run_health` and `bb lane-pilot health` show both.
- **One memory.** `lane_pilot_memory_import` brings a project's `.agents/memory` records (claude-lane schema 2) into the hub corpus with the audience taken from sensitivity; `lane_pilot_memory_export` writes hub records back as files, so terminal sessions and BB runs read the same memory. The hub corpus is the source of truth.
- **Routing hint in settings.** Under the writer picker the project shows which provider and model got tasks accepted at the first try per risk, against the configured pair.
- **server.ts is an entry point again.** Its 7 000 lines became modules under `src/server/`: a shared core (SDK, storage, host client, settings and section helpers), one factory per area (reconcile, activation, writer run, stages, nightly docs, probes, writer host) and three registration modules (RPC, tools, CLI). Modules call each other through one `Services` interface, so the call graph is explicit and each file can be read on its own. Every move is verbatim; the failing test set is identical to main.
## 0.1.25 — 2026-09-30

- **Parallel lanes never share a checkout.** «В папке проекта» (`adoc.040=in_place`) now runs writers one at a time in that folder, whatever the pool size says; `auto` and `worktree` give every attempt its own git worktree, so 5 or 10 lanes work at once without seeing each other's half-done edits.
- **Checks inside a worktree see the writer's own edits.** `node_modules` is mirrored entry by entry: third-party packages link to the base copy, monorepo workspace packages point back into the worktree, nested `<workspace>/node_modules` are mirrored too, and each workspace package's ignored `dist/` is copied so `exports → dist` resolves. Before, one symlink sent every `@scope/*` import to the base checkout.
- **A merge blocked by uncommitted edits in main is named as such**, with the files, instead of a bare merge failure.

## 0.1.24 — 2026-09-30

- **Ownership is checked per task of a run, not against the union of every task's never_touch.** In a shared in-place checkout a sibling's changes appear in every attempt's diff; a path now passes when some task of the run owns it and does not never_touch it. Before, a sibling listing `apps/**` as never_touch rejected the owner's own files, and the whole run ended blocked.
- **Bookkeeping in the working tree is not the writer's change.** `.agents/**` (memory episodes, PROGRESS.md, design probes, run locks), `.bb/**` chat exports and cache folders that hooks and sibling agents write during an attempt are left out of the ownership check unless the task owns them.
- **A missing read_first path no longer blocks the task.** The packet names the path as absent and the writer is still dispatched; a line window outside a file still fails closed.
- «retry limit 2 exhausted» keeps the reason of the last failed attempt after the colon.

## 0.1.13 — 2026-09-26

- **Every native Lane chat is its own run.** A project needs no Lane Pilot setup, and several Lane chats can run in one project; only the legacy PM pipeline keeps one PM per project.
- **Claude Lane is installed once, the standard way.** A machine with Claude Lane (`~/.agents/install.json` plus the `lane-stack` Claude plugin) is used as is and never removed with Lane Pilot. A machine without it gets `claude-lane-stack` cloned to `~/.local/share/claude-lane-stack-installed` at the tested revision and its own `install.sh` run in the real home, with `flock` (Homebrew) and PyYAML/jsonschema added when missing. The staged, ownership-tracked install is gone; existing manifests still disable and remove as before.
- **Lane Pilot repairs Claude Lane itself** on install and whenever it is enabled: it refreshes a Claude plugin cache left behind by a same-version update, trusts the Codex Lane hooks, and registers the OpenCode Lane plugin also in `opencode.jsonc`.
- **Installation starts when Lane Pilot is enabled** in the composer, on the machine the chat will use; a send waits up to 5 s for a running install and reports a failed install with its reason.
- **Settings inherit: Общие настройки → project → section.** «Общие настройки» is the full settings panel at a level every project and section inherits live; a value set in a project or section overrides it there, and «Вернуть унаследованное» drops back to the level above. Sections from project-folders appear under their project. The global model catalog comes from any connected machine.
- The model picker no longer replaces a saved selection with the catalog's first model (it showed «6-Astra Low») while the settings screen loads.
- Switches for true/false settings (Документы, Память проекта) save again.
- Checked skills, tools and MCP servers of an agent profile are listed first.
- Bundle Claude Lane agents from `a43826b` (Designer prototype/mockup modes, `cocoon-chainsmith` for the SEO specialist) and pin installs to that revision. `scripts/bundle-lane-agents.py` regenerates the bundle and reproduces the previous one exactly.

## 0.1.12 — 2026-09-24 (predeploy candidate; not installed)

- Add native plan critique, run policy, workspace routing, writer/verification receipts, cancellation and restart reconciliation.
- Add night review/fix, specialist/onboarding, project-scoped memory, living docs, controlled Browser QA and fail-closed sandbox stages with native EN/RU settings.
- Expand the source-backed catalog to 366 rows (355 original tuples plus 11 native controls); keep inventory classification distinct from installed acceptance.
- Integrate the reviewed Lane Stack coexistence and guarded install/rollback adapters. Hub delivery and installed acceptance remain pending exact combined review.

## 0.1.11 — 2026-09-23

- Render Diagnostics CLI preview as scrollable JSON after a live SourceCode renderer failure on the hub.
- Keep the missing-credential Jev test independent of a permanently installed host credential file.
- Allow unrelated CAS settings saves through both single and batch RPCs after a native writer selection, while preserving validation of legacy writer groups and other enumerated settings.
- Reject cancellation of terminal or closed attempts before stopping a thread; show only legal Monitor actions in mobile and desktop layouts.

## 0.1.0 — 2026-09-23

First public release of Lane Pilot for BB.

- Isolated PM activation (Mode 2) and native BB writer dispatch
- Host worker: detect / install / snapshot / rollback / OpenCode connect / one-shot import
- Settings UI (EN/RU) from the adoc coverage matrix, CAS storage, run monitor
- CLI and BB writer pipelines with task-v2 and acceptance-v2
- Public GitHub, GitNexus index, hub install via the standard path-plugin delivery
- Catalog hygiene: excluded LANE_STACK_ROOT default quotes `~/tools/claude-lane-stack`, not an absolute host path

Based on [VKirill/claude-lane-stack](https://github.com/VKirill/claude-lane-stack) v1.38.0 (`747a9ff9b2fa4ffdcf5c65c8d07eff2b9386a821`), MIT.

## 0.0.1-stage0

Internal executable prototype (stations A–C). Not a public GitHub release.
