# Lane Pilot

BB plugin that runs [Lane Stack](https://github.com/VKirill/claude-lane-stack) in two modes without duplicating the engine: ordinary Claude/adoc in a terminal, and an isolated PM thread inside BB that delegates work to native BB writers.

Based on [VKirill/claude-lane-stack](https://github.com/VKirill/claude-lane-stack) v1.38.0 (SHA `747a9ff9b2fa4ffdcf5c65c8d07eff2b9386a821`), MIT. Copied files under `lane-stack/hooks/` and `lane-stack/schemas/` keep the upstream MIT copyright (`lane-stack/schemas/LICENSE`). Lane Stack itself is not re-published.

Кратко по-русски: плагин подключает Lane Stack к BB — обычный CLI без изменений и отдельный PM-тред в BB с писателями как скрытыми тредами. Upstream не форкается.

Назначение: isolated PM + writer dispatch for Lane Stack on BB.
Владелец работы: AG-196 / AG-177.
Статус: active.
Проверено: 2026-09-23; 0.1.10 на хабе прошла полный Jev→native writer→PM receipt и живые клики EN/RU. Версия 0.1.11 исправляет отображение CLI preview в Diagnostics; запись о её live-проверке — в отчёте AG-246.

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

## Project settings and native writers

The settings panel keeps the project list on the left and the selected project's settings on the right. Provider, model, supported reasoning level, and service tier are saved as one compare-and-swap selection from BB's host-routed native writer catalog. For example, the catalog entry `gpt-6-luna` with service tier `fast` is stored as one writer choice; fast does not change the reasoning level. The two Jev routing controls are regular settings. Night review is shown as unavailable because Lane Pilot does not run it.

Technical fields, including argv/environment previews, unapplied settings, storage versions, import paths, and receipts are grouped under Diagnostics. The old `writer.fast_mode` value is diagnostic only and migrates to `writer.service_tier` only when no explicit tier has been saved.

Панель настроек показывает список проектов слева и настройки выбранного проекта справа. Провайдер, модель, доступный уровень reasoning и service tier сохраняются атомарно из каталога BB для host проекта. Например, выбор `gpt-6-luna` с tier `fast` не меняет reasoning. Два переключателя Jev управляют маршрутизацией. Ночное ревью помечено как недоступное: Lane Pilot его не запускает.

Технические сведения — argv/env, неприменённые настройки, версии хранения, пути импорта и квитанции — находятся во вкладке Diagnostics. Старый `writer.fast_mode` виден только там и переносится в `writer.service_tier`, если явный tier ещё не сохранён.

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

For BB PM delegation, set task-v2 `project_cwd` to exactly the project's configured writer workspace. The value is captured when the PM run starts; changing the project setting does not change an active run. `lane_pilot_dispatch_writer` returns immediately, then `lane_pilot_wait_writer` returns the receipt or indicates that another bounded wait is needed.

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
- Plugin SDK 0.4.104 does not expose BB's selected UI language. Lane Pilot stores `auto` (default) or an explicit EN/RU override globally in plugin KV. In auto mode, the Russianizer's `data-footer-item="plugin:ru/toggle"` DOM action marks its language signal: the Russianizer is enabled when `bb-plugin-ru:enabled` is absent or is anything other than `off`, and only the explicit `off` value disables it. When that action is absent or disabled, `navigator.language` is checked before a non-default document language (BB's `en` is treated as unknown); the final fallback is EN. A DOM observer and storage listener update mounted Lane Pilot surfaces when this signal changes. The explicit Lane Pilot override takes precedence. The old per-project `ui.language` control is removed from the Lane Pilot panel. The native BB locale is therefore a known SDK limitation rather than a synchronized setting.
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
