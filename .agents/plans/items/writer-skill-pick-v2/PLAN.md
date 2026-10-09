# Writers get task-relevant skills picked by Jev (v2, calibrated design)

Redispatch of canceled `writer-skill-pick`. Its writer went silent when the provider ran out of quota. Start from main; the earlier worktree is gone.

## Context
- The writer spawn (src/rooms/writer/server/spawn.ts, `requiredPolicyField(bb, helperSnapshot, writerProviderId, "writer")`) passes no extra access. A writer therefore sees only ROLE_PROFILES.writer skills: writer-practices and karpathy-guidelines.
- A per-spawn `ExtraAccess` already exists (roleProfilePolicy in src/rooms/native-agent/helper-context.ts; workflows use it through extraAccessOf in src/rooms/workflow/server/workflow-agent.ts).
- task-v2 tolerates a `skills` key (src/rooms/tasks/task-v2.ts).
- relevantRules in spawn.ts plus packages/run-insights/src/rules.ts (ruleRelevanceState, ruleRelevanceQuestions, pickRelevantRules) is the model to follow. It sends chunks of 8 Jev questions through host `councilJudge` with a 6 s timeout, reads `probabilities.yes` and keeps `>= threshold`.

## Calibrated design (PM measured it on 28 real hub tasks against a 213-skill catalog; build exactly this)
1. **Task field.** `skills?: string[]` becomes an explicit optional task-v2 field (≤8 names). These are PM hints.
2. **Catalog index.**
   - Source: the skills the writer host lists (BB skill list via SDK or an existing host call), cached ~10 min per host.
   - Drop `plugin:name` duplicates when the plain `name` exists, and drop writer-practices and karpathy-guidelines.
   - An empty description is read from the SKILL.md frontmatter `description:`. A skill that still has none is skipped: name-only skills ranked top by mistake.
3. **Kind filter** (task-independent, cached by sha256(name+description), e.g. in plugin KV).
   - One Jev `choice` per skill, chunks of 8. State: `{catalog:"skills an agent can load"}`.
   - Instructions: `Skill — <name>: <description[:420]>\nWhat is this skill mainly about?`
   - Criteria:
     - `domain`: "doing real work in a product, codebase, framework, technology, platform, API or content field (for example a specific app, a library, design, SEO, a cloud, a payment API)";
     - `agent_ops`: "how AI agents themselves are run or organised: orchestration, task contracts, lanes, memory, sessions, skills authoring, prompts, BB/agent configuration, sign-in of tools".
   - Drop a skill when `probabilities.domain < 0.2`.
4. **Per-task question** (Jev `choice`, chunks of 8, all in parallel, 6 s each).
   - Instructions: `Skill — <name>: <description[:420]>\nThe agent will edit code for this task. Does this skill teach how to work with the specific product, codebase or technology the task's files and commands belong to? Skills about running agents, orchestration, memory, planning or other products are no.`
   - Criteria: yes = "yes: the skill covers the exact product, codebase or technology of this task", no = "no".
   - State: `{task:{title, objective[:1200], owns_paths, expected_outputs, acceptance, verification_commands, project_folder: project_cwd, plan: PLAN text[:4000]}}`. **The plan is required:** without it, three.js skills ranked 115–165 for three.js tasks.
5. **Pick.** `probabilities.yes >= 0.3`, sorted, top 5.
6. **Project-folder rule.** Always add a plain skill (no ':', name ≥ 6 chars) whose name is contained in the last two path segments of project_cwd, e.g. `selfystudio` for /home/ubuntu/apps/selfystudio.
7. **Union** with the task.skills hints and pass the result as `ExtraAccess.skills` to requiredPolicyField for the "writer" and "code-repair" spawns of the task. Base role skills always stay. A failed chunk adds nothing. The whole pick is bounded at about 15 s and never blocks the spawn.
8. **Receipt.** Record the picked skills and their p(yes) in the task's writer-agent stage result or receipt, so the PM sees them.
9. **Setting.** `writer.skill_pick` (on|off, default on) in the settings catalog with en/ru copy, near the writer role in the Agent access tab. When off, only the hints are added.

Measured result of this setting: recall 0.90, 0.21 wrong extras per task, latency about 0.3 s per request.

## Checks
- `tests/jev/skill-pick.test.ts` with stubbed Jev probabilities:
  - kind filter;
  - threshold;
  - top 5;
  - project-folder rule;
  - plan present in the state;
  - unknown names dropped;
  - an error gives an empty result.
- `tests/writer-skill-pick.test.ts`:
  - picked plus hints reach the writer policy;
  - base skills stay;
  - setting off means hints only;
  - a pick error means base skills only.
- `tests/task-v2.test.ts`: the `skills` field is accepted and validated.
- Typecheck.

## Delivery
- [x] Writers receive Jev-picked task skills with hints, receipts, and the writer.skill_pick switch — accepted in run `lprun_3830fb02731046e89c6d9706ca217fd7`; merged as `c390253`.
