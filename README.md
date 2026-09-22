# Lane Pilot

Stage 0 executable prototype for an isolated Claude PM that delegates a task to a native BB writer.

The guard copy under `lane-stack/hooks/` is based on
[`VKirill/claude-lane-stack` v1.38.0](https://github.com/VKirill/claude-lane-stack),
commit `747a9ff9b2fa4ffdcf5c65c8d07eff2b9386a821`, MIT License,
Copyright (c) 2026 VKirill and contributors. The original PM roles keep their
upstream behavior; Lane Pilot adds a stricter `lane-pilot-pm` branch before
`PM_AGENTS`.

This prototype uses only public Plugin SDK surfaces. It does not call Agency RPC.
The host worker exposes `detect`, `snapshot`, `install`, `rollback`,
`importConfig`, `connectOpencode`, and the original `snapshotDryRun`.
Install uses a managed checkout at `~/.agents/lane-pilot/upstream/<sha>`.
External operations run only when `confirmExternalOps` is true.

See `.agency/jobs/AG-190/stage0.md` for the reproducible live scenario and rollback.
