# Who calls Lane Pilot's RPC methods and CLI commands

The rules are in `src/server/owner-gate.ts` (`RPC_CLASS`, one class per RPC method), `src/anamnesis/access.ts` (what a request to the anamnesis does)
and `src/server/schedule-cli.ts` (`scheduleCliMethod`). `tests/owner-gate-callers.test.ts` and `tests/owner-gate-cli.test.ts` keep every legitimate
caller below working: a refusal of one of them is a bug, not a security feature.

## Caller kinds (set by the VK core, `vk.rpcCallerPolicy`)

| Kind | Who | While there is no owner login |
| --- | --- | --- |
| `owner-ui` | The Lane Pilot page in the owner's browser | Passes everything (the host proxy cuts a forged `Origin`). |
| `owner-cli` with a proof (evidence other than `cli-header`) | The owner's `bb` after the core's owner login | Does not exist yet; would pass everything. |
| `unverified-owner` (also an `owner-cli` mark that has only the `x-bb-vk-client: cli` header behind it) | The owner's `bb` in a terminal, or an agent that writes the same header | Ordinary changes pass; schedules, the anamnesis, agent profiles, installs and self-repair controls meet the owner's form in the PM chat. |
| `agent-thread` (per-thread token, or a CLI call that names a thread) | An agent session | Reads pass; every change meets the form; sensitive anamnesis is never shown; widening anamnesis changes are refused. |
| `plugin` | Another loaded plugin | Passes (the anamnesis: reading only). |
| `unknown` | `curl`, `python`, `node fetch`: no identity | Refused with an instruction. |
| no mark | A core without the function | Passes, as before. |

A "form" is the owner's yes/no card in the PM chat of the project (it reaches the phone). It comes by itself on the first refused call; after a yes the
same call (same input) passes once within ten minutes: the caller repeats it.

## Legitimate callers and their way in

| Caller | What it calls | Path that works |
| --- | --- | --- |
| Lane Pilot page (settings, board, workflows, rules, anamnesis tab later) | every RPC | `owner-ui`: passes. |
| Owner's `bb` in a terminal | `bb plugin rpc call lane-pilot …`, `bb lane-pilot …` | Ordinary: passes. `schedule create|update|resume|run-now`, `anamnesis` changes and sensitive reads, `save_agent_profile`, `stack_*`, `native_install_start`, `self_repair_configure|tick`, `workflow_draft_publish`: a form in the PM chat, answer yes once, repeat the command. |
| `scripts/lp-drill.py` (`save_setting`, `reset_project_settings` as the owner's CLI, `activate`, `cancel`, `finish`, `configure`) | RPC + CLI | Settings are ordinary: pass. The CLI commands are not gated. |
| `bb-plugin-push` | `deploy_status`, `canary_status`, `self_repair_status` (reads), `deploy_drain` (ordinary change) | Pass for any caller; from an agent session `deploy_drain` meets the form and the script falls back to its older wait. No form is asked for an incident deploy any more. |
| `scripts/self-repair-watchdog.sh`, `scripts/lp-canary.sh` (on the hub) | `self_repair_status`, `canary_status` | Reads: pass without identity. |
| lane-memory hub client, agents' own memory | `session_memory_project|search|core` (reads), `session_memory_write`, `session_lesson` (class `agent`) | Every caller, as before. |
| Schedule board and automations | in-plugin executors; `bb lane-pilot workflow-trigger` called by an automation | Not RPC calls; `workflow-trigger` is not gated. The board's changes follow the rules above. |
| Other plugins (e.g. project-folders) | any | `plugin` caller: passes. |
| PM / agents | reads; `workflow_run`, `halt_run`, … from their shell | Reads pass. A change: a form comes by itself ("asked in the PM chat; once they allow it, call again"). PM tools (`lane_pilot_schedule` etc.) are in-process and keep their own forms. |
| Metrics script `scripts/lp-metrics*.sh` on the hub | reads `data.db` with sqlite | No RPC. |
| `anamnesis` CLI/RPC, an agent in an ordinary chat or the PM | `list`, `show`, `whoami`, `card`, `status`, `review` | Pass (never from a writer, helper or stage thread). |

## What an agent is told when it is stopped

- No identity: "came with no identity … use the Lane Pilot page in BB or bb … a form to the owner appears in the PM chat by itself when it is needed".
- A change: "The owner was asked in the PM chat; once they allow it, call again." (or "A question is open", "declined a short while ago", "No PM chat is open to ask in: open the project's PM chat in BB").
- Sensitive records, or a change that widens what agents see: refused with "tell the owner" and no form (the owner does it in their own terminal or page).

## Open edges

- `helper.access.*` and `browser_qa.approve` settings are ordinary: an agent that writes `x-bb-vk-client: cli` on a core without the owner login can change them.
- A CLI command that is not in the table (`configure`, `budget`, `host-*`, `finish`, `cancel`) is still gated by the shell guard only.
