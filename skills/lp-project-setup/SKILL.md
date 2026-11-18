---
name: lp-project-setup
description: "Initialize and prepare a project for Lane Pilot: inspect stack, commands, module boundaries, create .agents/pilot/ context/architecture/rules, update AGENTS.md map, and sync project-local skills in .bb/skills/. Use when: подготовить проект к пилоту, настроить проект для Lane Pilot, инициализировать проект, описать архитектуру проекта, /lp-project-setup. SKIP: implementing product features (lp-implement, lp-writer) or running verification gates (lp-verify)."
license: MIT
---

# Lane Pilot — Project Setup & Readiness

> Adapted from `lee-to/ai-factory` (`/aif` + `/aif-architecture`, MIT) for Lane Pilot project workspaces and BB `.bb/skills/` project-local skill layout.

Prepare an uninitialized or partially configured repository so future Lane Pilot sessions, workflow graphs, and clean subthreads work autonomously from accurate project-local context without relying on machine-scattered skills.

## Hard Boundaries

1. **Setup only — do NOT implement application features.** Do not rewrite business logic, install unrequested production dependencies, or alter database data.
2. **Preserve owner files.** Never overwrite user-written rules outside managed markers (`<!-- bb-project-folders:agents:start/end -->` and `<!-- lane-pilot:project-context:start/end -->`). If `.agents/pilot/DESCRIPTION.md`, `.agents/pilot/ARCHITECTURE.md`, or `.agents/pilot/rules/base.md` already contain confirmed project prose, refine and merge verified facts instead of wiping them.
3. **Runtime-aware questions.** Ask the owner only when a missing choice genuinely changes project configuration (for example, target UI/artifact language when undetermined from repository files, or ambiguous primary app directory in a multi-product monorepo). In background/subagent runs, never invent consent: use safe repository-evidenced defaults and report open questions explicitly.

## Project-Local Layout

Lane Pilot keeps project knowledge and standardized skills **inside the project folder**:

- `.agents/pilot/config.json` — Pilot manifest (`version`, `languages`, `delegation`, `commands`, `installedSkills`).
- `.agents/pilot/DESCRIPTION.md` — Stack, runtime, entrypoints, package manager, external services, and verified check commands (`typecheck`, `lint`, `test`, `build`).
- `.agents/pilot/ARCHITECTURE.md` — Directory map, module boundaries, dependency direction, where new code belongs, and forbidden cross-module shortcuts.
- `.agents/pilot/rules/base.md` — Concrete codebase conventions discovered in existing code (naming, error handling, state/SQL rules, logging, test style) with `file:line` citations.
- `.agents/pilot/skill-context/delegation.md` — Managed subthread delegation rules (when configured from the Lane Pilot chat panel).
- `.bb/skills/<skill-name>/SKILL.md` — Standardized system skills stored inside the project so BB `readWorkspaceAgentContext` and clean subthreads read them directly from the checkout.
- `AGENTS.md` — Root agent instructions keeping `bb-project-folders` intact plus a concise project map and pointers to `.agents/pilot/*`.

## Execution Workflow

### Step 1. Inspect Actual Repository Facts
Read root manifests (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `composer.json`, CI workflows, git hooks, existing `AGENTS.md`, `README.md`, and `.agents/passport/PASSPORT.json` if present). Confirm every command and path against real files — never guess commands that do not exist in the repo.

### Step 2. Resolve Language & Manifest (`.agents/pilot/config.json`)
1. Read `.agents/pilot/config.json` if present; preserve `delegation` and owner settings.
2. Resolve `languages.ui` and `languages.artifacts` from existing config, `AGENTS.md`, or user language (defaulting `technicalTerms` to `"keep"`).
3. Record verified `commands` (`typecheck`, `lint`, `test`, `build`) with exact working directories.

### Step 3. Write Project Context & Base Rules
1. Write `.agents/pilot/DESCRIPTION.md` with:
   - One-paragraph factual summary of what the project is and runs on
   - Verified stack, runtime versions, and package/workspace layout
   - Exact check commands (`typecheck`, `lint`, `test`, `build`) and environment prerequisites
2. Write `.agents/pilot/rules/base.md` with concrete conventions backed by `file:line` examples from the repository (one owner per rule/vocabulary, test expectations, error handling, security/secret boundaries).

### Step 4. Write Module Architecture (`.agents/pilot/ARCHITECTURE.md`)
Document:
- Architectural pattern (rooms/packages, layered, feature-sliced, monorepo apps, etc.)
- Responsibility and public entrypoint of each top-level module/folder
- Allowed import direction and boundary tests (if any)
- Exact placement rules for new routes, domain logic, UI components, migrations, and tests

### Step 5. Update Root `AGENTS.md` Safely
Keep any `<!-- bb-project-folders:agents:start --> ... <!-- bb-project-folders:agents:end -->` block untouched. Update or append the `<!-- lane-pilot:project-context:start --> ... <!-- lane-pilot:project-context:end -->` section pointing agents and clean subthreads to `.agents/pilot/DESCRIPTION.md`, `.agents/pilot/ARCHITECTURE.md`, `.agents/pilot/rules/base.md`, and `.bb/skills/`.

### Step 6. Verify Readiness & Report
Confirm all created files are valid UTF-8, `.bb/skills/` contains the standardized Pilot skills (`lane-pilot`, `lp-project-setup`, `lp-plan`, `lp-implement`, `lp-verify`, `lp-writer`, `lp-docs`, `lane-memory`, `project-life`, `lp-agentic-discipline`, `karpathy-guidelines`), and report:
- Files created or updated
- Verified stack check commands
- Any optional readiness steps still open (Git hooks or CI)
