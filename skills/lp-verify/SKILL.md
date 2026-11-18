---
name: lp-verify
description: "Authoritative read-only verification gate against the active plan, .agents/pilot/ARCHITECTURE.md, .agents/pilot/rules/base.md, and project test/typecheck/lint/build commands, emitting a structured gate verdict. Use when: проверить реализацию по плану, запустить финальный verify-гейт, сверить код с архитектурой и правилами, /lp-verify. SKIP: implementing code changes (lp-implement, lp-writer) or initial project setup (lp-project-setup)."
license: MIT
---

# Lane Pilot — Authoritative Implementation & Rules Verification Gate

> Adapted from `lee-to/ai-factory` (`/aif-verify` + `/aif-rules-check`, MIT) for Lane Pilot quality gates and chat panel reporting.

Verify actual repository changes against the selected plan, project architecture, project rules, and stack verification commands without modifying implementation files.

## Hard Boundaries

1. **Verification is read-only on source code.** Do not silently patch code, mark plan checkboxes `[x]`, install missing tools, invent CI pipelines, or create git commits during verification.
2. **Evidence over claims.** Plan checkboxes (`[x]`) and earlier worker summaries are claims, not proof. Re-read `git status`, `git diff`, touched files, and run actual check commands in their working directory.
3. **Never fabricate PASS.** Any check that could not run must be reported honestly as `NOTRUN` or `UNKNOWN` with its exact reason.

## Verification Checklist

1. **Plan Completeness:** Compare every task and acceptance requirement in the active `.agents/pilot/plans/<slug>.md` (or chat task specification) against actual code changes (`file:line`). Flag missing requirements, partial stubs, or out-of-scope edits.
2. **Architecture & One-Owner Rules:** Check changed files against `AGENTS.md`, `.agents/pilot/ARCHITECTURE.md`, and `.agents/pilot/rules/base.md`:
   - Module import boundaries respected (no forbidden cross-module deep imports or cycles)
   - No duplicated constants, schemas, or helpers that already have a canonical home
   - Tests exercise real public behavior rather than tautological mock assertions
3. **Security & Hygiene:** Check for leaked secrets/tokens, unvalidated external inputs, unsafe shell/path handling, or leftover temporary artifacts in the repository root.
4. **Stack Checks:** Run existing project commands from `.agents/pilot/DESCRIPTION.md` or `package.json` (`typecheck`, `lint`, `test`, `build`) and capture exact exit codes and failure lines.

## Output Format

Present a concise Russian summary (verified items, command results, blockers) followed by a machine-readable `lp-gate-result` JSON fence:

```json
{
  "gate": "lp-verify",
  "status": "pass",
  "blocking": false,
  "target": ".agents/pilot/plans/example.md",
  "checks": { "typecheck": "pass", "lint": "pass", "tests": "pass", "build": "pass" },
  "blockers": [],
  "suggested_next": { "action": "commit", "reason": "Все задачи плана и проверки пройдены без блокеров." }
}
```

Set `"status": "fail"` and `"blocking": true` whenever any required task is incomplete, any stack check exits non-zero, or a Critical/Major architecture, correctness, or security defect is found.
