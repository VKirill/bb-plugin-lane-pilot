---
title: Skill standard
type: component
created: 2026-11-06
updated: 2026-11-06
status: active
confidence: medium
tags: [skills, forge, lint, standard]
sources:
  - src/rooms/forge/skill-lint.ts
  - src/rooms/forge/logic.ts
  - src/rooms/docs/docs-lint.ts
  - src/rooms/tools/server/cli.ts
---

# Skill standard

The bar every skill meets, forged or published: `SKILL.md` plus the `references/` and `scripts/` it names. The lint is `src/rooms/forge/skill-lint.ts:1`; the forge's `lintDraft` calls the same rules for a one-file draft (`src/rooms/forge/logic.ts:26`), and `bb lane-pilot skill-lint <dir>` checks a local folder such as `~/.bb/skills/<name>/` (`src/rooms/tools/server/cli.ts:414`).

## Rules

- **Description**: at most 1024 characters, says what the skill does, carries «Use when …» and a «when not to use it» clause («not for …», «SKIP: …»). The «not for» part is a warning, the rest errors.
- **Body**: `SKILL.md` stays under 500 lines and 8 KB — DSH truncates tool results at 8192 bytes, so longer material moves to `references/` (warnings, not errors).
- **Shape**: frontmatter with a kebab-case `name` and the description; no `draft: true`; no forbidden grant (permission bypass, every tool, destructive shell, secrets, the guard or hooks, a download piped into a shell).
- **Named files**: every `references/x.md` or `scripts/x` the skill names must exist in the folder — an error.
- **Scripts carry their check**: a script that swallows errors (`|| true`, `2>/dev/null` on the main command, `except: pass`, `except Exception: pass`, an empty `catch {}`) gets a warning naming the line — the script proves its result, not its exit code.
- **Writing style**: a rule inside a skill reads «when / do / when not»; edits are point edits, never a full rewrite; lessons come from failures too; long material lives in `references/`; one skill per reason to change — two references of one skill are not two skills.

## How it works

`lintSkillDir(files)` (`src/rooms/forge/skill-lint.ts:88`) returns `{ errors, warnings }`; errors block, warnings advise. Frontmatter is read by `parseFrontmatter` (`src/rooms/docs/docs-lint.ts:48`), which folds a multi-line `description: >`. The CLI walks the folder, keeps text files, and exits 1 when any error stands.

## Delivery: which layer wins, and why a plugin-only skill does not arrive

BB builds the skill catalog of a session in `resolveSkillCatalogEntries` (core, `apps/server/src/services/skills/injected-skills.ts`). Priority, highest first: project skills, then the owner's skills (the hub copy in `~/.bb/skills`, scope `bb-user`), then plugin skills (`skills/` of an installed plugin, scope `plugin`). On a name clash the higher layer wins and the lower one is dropped silently (`excludeOverriddenLowerPriorityUserSources`): a skill that lives in the repository and on the hub is delivered from the hub, so a repository edit changes nothing for agents until it is published.

A Lane Pilot role starts with a session policy (`ROLE_PROFILES`, `src/rooms/contracts/helper-context.ts`). Its `bbPlugins` list is empty for almost every role, and `lane-pilot` is not a mandatory plugin, so the core puts every skill whose provenance is the plugin `lane-pilot` into `bbSkillsDenied` (`buildVkRuntimeSessionPolicy`, `apps/server/src/services/threads/vk-session-policy.ts`). A hub skill has no plugin and passes the plugin filter; it then has to be on the role's `skills` allow-list (a graph node adds its own `skills` to it). Consequences:

- `project-discovery-grill` exists only in the plugin, so no policy-bound Lane Pilot session (writer, graph node, PM helper) receives it. Only `workflow-architect` and `lead` allow the plugin, and they have no use for it.
- Fix, no code change: publish it to the hub (`bb tools skills-publish`, see the publish list in the skills-standard work), so it arrives as an owner skill. `project-passport` nodes name it in `skills`, which puts it on the node's allow-list.
- Rule for new skills: a skill that a graph node, a role or an overlay loads by name must be on the hub when the plugin is released; the plugin folder is the source, the hub copy is what agents read. `tests/skills-shipped.test.ts` checks that every name referenced exists in `skills/` or in `policy/external-skills.json`; it cannot see the hub.

<!-- lane-pilot:backlinks -->
## Referenced by

- [Self-improvement](guide/self-improvement.md)
