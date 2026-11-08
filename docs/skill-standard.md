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

<!-- lane-pilot:backlinks -->
## Referenced by

- [Self-improvement](guide/self-improvement.md)
