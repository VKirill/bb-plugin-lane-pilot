---
title: Writer credential isolation without an OS user
type: decisions
created: 2026-11-24
updated: 2026-11-25
status: active
confidence: high
tags: [security, isolation, sandbox, writer, operations]
sources:
  - src/rooms/platform/server/pm-spawn.ts
  - src/rooms/verification/credential-paths.ts
  - src/rooms/verification/sandbox.ts
  - src/rooms/verification/worker-user.ts
  - src/rooms/native-agent/claude-guard-launch.ts
  - src/rooms/native-agent/server/helper-bb-shim.ts
  - scripts/lp-worker-user.sh
---

# Writer credential isolation without an OS user

TL;DR: Lane Pilot cannot run writer processes as a separate OS user because BB's host daemon spawns every thread as the daemon's own user (the owner) via `bb.sdk.threads.spawn` (`src/rooms/platform/server/pm-spawn.ts:102-148`). Until a second BB host is enrolled under a dedicated `lp-worker` user, writer isolation uses one shared credential path list, Claude `permissions.deny` + `sandbox` settings, and push-blocking git/SSH env entries, with explicit warnings recorded on the attempt trace when a provider ignores sandbox keys.

## Context

Writers currently run with `permissionMode: "full"` (`src/rooms/platform/server/pm-spawn.ts:127`) in the owner's OS account. The Python `PreToolUse` shell guard (`lane-stack/hooks/guard_shell.py`) stops accidental `git push`, but it is a text-level filter, not an OS boundary: shell tricks and unrestricted file reads (`~/.ssh`, `~/.claude.json`, `~/.bb`, `~/.codex/auth.json`, `~/.claude/.credentials.json`, `~/.config/gh`) remained reachable by any writer process or child command.

Two host-level findings from inspecting the local macOS environment (`2026-11-24`) also block simple local `su`/`sudo` OS-user isolation:

1. **`/Volumes/SSD` is mounted `noowners`** (`apfs, local, nodev, nosuid, journaled, noowners`). macOS ignores POSIX ownership and mode bits (`0600`) on `noowners` volumes, so `/Volumes/SSD/Agents/codex/auth.json` (target of `~/.codex`), `/Volumes/SSD/Agents/claude` (target of `~/.claude`), and repositories/worktrees under `/Volumes/SSD` are not separated between local OS users there.
2. **`staff` group traversal on the owner's home:** `scripts/lp-worker-user.sh create` previously assigned `PrimaryGroupID 20` (`staff`) to `lp-worker`. Because the owner's home directory is `drwxr-x---` group `staff`, `lp-worker` could traverse `~` and read any group-readable file such as `~/.claude.json` (`0644`). `scripts/lp-worker-user.sh` now creates a dedicated group per worker user instead of `staff`, and probes the unified credential list including resolved symlink targets.

## Options Considered

| Option | Who enforces | Feasible in plugin | Effort | Key drawbacks |
|---|---|---|---|---|
| 1. `sudo -n -u lp-worker` in launcher | Claude launcher script | Claude only (no Codex exec hook) | L (1–2 weeks) | Breaks keychain-backed logins (`CLAUDE_CODE_OAUTH_TOKEN` rotation needed), `/var/empty` breaks hooks writing `~/.agents/state`, ACLs fail on `noowners` volumes |
| 2. Second BB host enrolled as `lp-worker` | BB host daemon (`bb machine enroll`) | Yes (host selection already per-writer) | L | Separate logins/subscriptions, separate clones + fetch-based merge handoff, duplicated host settings/toolchains, still requires dedicated group and fixing `noowners` |
| 3. Containers (`docker run`) | Launcher / container runtime | Heavy in launcher | L | Common `.git` mount needed for worktrees, path translation mismatch, slow macOS FS, host `bb` unreachable |
| 4. Provider settings + push-blocking env (+ launcher Seatbelt/bwrap only if drill shows gaps) | `claude-guard-launch.ts` + `helper-bb-shim.ts` | Yes (plugin owns launcher, settings, env) | S–M (2–3 days) | Claude `sandbox` covers Bash children while `permissions.deny` covers Read/Edit; non-Claude providers (`codex`, `opencode2`, `acp-cursor`, `devin`) ignore Claude `sandbox` keys |

## Decision

1. **One credential path list (`src/rooms/verification/credential-paths.ts`):** Merge the previously drifted lists from `sandbox.ts` and `worker-user.ts` into one owner module covering `.ssh`, `.gnupg`, `.aws`, `.azure`, `.config/gh`, `.bb`, `.codex`, `.claude`, `.git-credentials`, `.netrc`, `.claude.json`, `.codex/auth.json`, `.claude/.credentials.json`, plus the resolved targets of `~/.codex` and `~/.claude` symlinks.
2. **Writer Claude settings (`src/rooms/native-agent/claude-guard-launch.ts`, `native-claude-host.ts`):** For `writer` and `emergency-writer` only (never PM or helpers), inject `Read`/`Edit` `permissions.deny` rules for the credential list and a `sandbox` block (`enabled: true`, `allowUnsandboxedCommands: false`, `filesystem.allowWrite` = worktree + task home + temp, `filesystem.denyRead` = credential list). `MERGE_SETTINGS_PY` preserves and unions list rules across BB core, guard, and user deny layers.
3. **Push-blocking writer environment (`src/rooms/native-agent/server/helper-bb-shim.ts`, `claude-guard-launch.ts`):** Contribute `GIT_SSH_COMMAND=/usr/bin/false`, `GIT_ASKPASS=/usr/bin/false`, `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=credential.helper`, `GIT_CONFIG_VALUE_0=""`, and empty/unset `SSH_AUTH_SOCK` for writer roles across all providers.
4. **No silent drops:** Log `INFO writer.isolation attempt=… denies=n sandbox=on|off push_env=on|off` and emit `WARN` + record `isolation` on the attempt's `ReasoningTrace` whenever a provider does not accept the sandbox keys (e.g., `codex`, `opencode2`, `acp-cursor`, `devin`).
5. **Conditional launcher sandbox:** Defer wrapping the `claude` process itself in `sandbox-exec` / `bwrap` (reusing `buildSeatbeltProfile` / `buildBubblewrapArgs` from `src/rooms/verification/sandbox.ts`) unless the live isolation drill (Task 22) finds readable credentials or push gaps under `permissionMode: "full"`.

## Real OS-User Design (Deferred)

The only true OS-user separation under BB is **Option 2: enrolling a second BB host as `lp-worker`** (`bb machine enroll`), with its own daemon, home directory, non-`staff` group, and storage outside `noowners` mounts. Its operational cost includes:

- Separate provider logins and subscriptions under the `lp-worker` OS account (`claude`, `codex`, etc.).
- Separate git checkouts/worktrees on the worker host and a fetch-based handoff to integrate commits back into the owner's checkout.
- Duplicated host rows in BB and per-host settings/toolchains (`git`, `node`, `python3`, `vitest`, etc.).

Adopt Option 2 only if the measured drill and threat model require hard OS-account separation beyond the sandbox, denies, and push-blocking environment.

## Status

Active. Verification of the generated settings, env, and script parity runs in `tests/writer-isolation.test.ts`; live end-to-end drill receipt runs during Task 22 before re-enabling the plugin.
