# Lane Pilot

BB plugin that runs [Lane Stack](https://github.com/VKirill/claude-lane-stack) in two modes without duplicating the engine: ordinary Claude/adoc in a terminal, and an isolated PM thread inside BB that delegates work to native BB writers.

Based on [VKirill/claude-lane-stack](https://github.com/VKirill/claude-lane-stack) v1.38.0 (SHA `747a9ff9b2fa4ffdcf5c65c8d07eff2b9386a821`), MIT. Copied files under `lane-stack/hooks/` and `lane-stack/schemas/` keep the upstream MIT copyright (`lane-stack/schemas/LICENSE`). Lane Stack itself is not re-published.

Кратко по-русски: плагин подключает Lane Stack к BB — обычный CLI без изменений и отдельный PM-тред в BB с писателями как скрытыми тредами. Upstream не форкается.

Назначение: isolated PM + writer dispatch for Lane Stack on BB.
Владелец работы: AG-196 / AG-177.
Статус: active.
Проверено: 2026-09-23; public repo, GitNexus on HEAD, hub 0.1.0, rollback to 0.0.1-stage0 and back.

| Field | Value |
|---|---|
| Host | Mac mini `host_7sea4qaad8`; hub bb-server |
| Canonical sources | this Git repository |
| Public GitHub | https://github.com/VKirill/bb-plugin-lane-pilot (public) |
| GitNexus | indexed from this checkout; name `bb-plugin-lane-pilot` |
| Install | `git:` URL or a `path:` checkout the hub can read |
| Data | plugin SQLite via BB storage (per project) |
| Dependencies | BB ≥0.43.3 `<0.44`, Plugin SDK 0.4.104, Lane Stack 1.38.0, Node 22/24/26 |

## Modes

1. **Terminal (Mode 1).** `claude` / `adoc` on the machine stay as installed Lane Stack. Lane Pilot does not patch global Claude settings for this mode.
2. **BB PM (Mode 2).** Explicit activation spawns a **new** PM thread. Settings come from the plugin store. Writers are hidden BB threads (or CLI writers on the project host). Ordinary chats are not PM sessions.

## Requirements

- BB `>=0.43.3 <0.44`
- `@get-bb/plugin-sdk` `0.4.104`
- Lane Stack **1.38.0** (`747a9ff…`) on the project host for CLI writers / install scenarios

## Install, update, rollback

```sh
bb plugin install git:https://github.com/VKirill/bb-plugin-lane-pilot.git --yes
```

Path checkout the BB server can read:

```sh
bb plugin build .
bb plugin install path:<absolute-checkout-on-the-server-host> --yes
```

Update: pull `main`, `npm run build`, reinstall or reload `lane-pilot`.

Rollback (plugin on the hub, not Lane Stack on a user machine):

```sh
bb plugin install git:https://github.com/VKirill/bb-plugin-lane-pilot.git@<previous-commit> --yes
# or a previously packed 0.0.1-stage0 tarball / previous path snapshot
```

## Detect and host worker

`bb lane-pilot host-detect <host-id> <workspace-path>` runs on the enrolled project host (`bb.host`), not inside the PM model session.

## Install scenarios S1–S8

| # | Situation | Lane Pilot |
|---|---|---|
| S1 | `~/.agents/install.json.source_sha` is the target SHA | Reuse; PM activation allowed |
| S2 | SHA present but different | Snapshot, then install to target SHA; rollback snapshot on failure |
| S3 | No `install.json` | Same as S2 without a mismatch warning |
| S4 | Already configured project | Idempotent; no duplicate hook merges |
| S5 | OpenCode `opencode.json` or `.jsonc` | Additive JSONC `plugin[]` patch |
| S6 | OpenCode missing | Skip S5 |
| S7 | Existing YAML | One-shot import into plugin storage; YAML is not written back |
| S8 | BB run | Never writes routing/night-shift/capabilities; never `adoc --apply` / `agents-doctor --apply` |

Matrix applicability (355 rows, including 88 read-only): [docs/adoc-applicability.md](docs/adoc-applicability.md).

## Known limits

- Raw Claude `agent_type` is not available; PM isolation uses project-scope settings plus plugin metadata.
- `MultiEdit` / `NotebookEdit` are not in the observed Claude runtime; Write/Edit/Bash guards still apply.
- External ops (`npm install -g @rama_nigg/open-cursor`, `open-cursor install`, Claude marketplace plugin install/uninstall) run only after explicit UI confirmation. Rollback records before/after; it does not promise a perfect restore of those ops.
- Plugin SDK 0.4.104 does not expose BB's selected UI language. Lane Pilot stores `auto` (default) or an explicit EN/RU override globally in plugin KV. Auto detection treats Russian document/browser language as a signal and then uses the Russianizer setting as a hint; otherwise it defaults to EN. The explicit Lane Pilot override takes precedence. The old per-project `ui.language` control is removed from the Lane Pilot panel. The native BB locale is therefore a known SDK limitation rather than a synchronized setting.
- BB's DOM-based Russianizer may translate portaled UI. Lane Pilot marks its own Radix portals and toast text with `data-bb-ru-skip` so they keep the selected plugin locale.
- BB owns the navigation panel's native “View details” menu entry. SDK 0.4.104 has no label/localization override for that host menu, so Lane Pilot cannot translate it.
- A closed PM run retains its history and stores `state=closed`, `closed_at`, and `closed_by` (`rpc` or `cli`). Finishing requires no open writer attempts and a confirmed idle/error PM thread; live finish does not delete threads.

Does not call Agency RPC. Uses public Plugin SDK only.

## Commands

```sh
npm test
npm run typecheck
npm run build
```

Also: `bb plugin types --check .`

CLI overview: `bb lane-pilot` (`activate`, `state`, `finish <project-id> [run-id]`, `dispatch-bb`, `dispatch-cli`, `host-detect`, `resume`, …).

## License

MIT. Upstream copies: Copyright (c) 2026 VKirill and contributors.
