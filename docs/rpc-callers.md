# Who calls Lane Pilot's RPC methods and CLI commands

Anyone. Owner decision 2026-10-08 («убрать, держать просто»): every machine is the owner's and BB is reachable only through his WireGuard, so
Lane Pilot has no protection from an evil agent: no caller check on RPC methods or CLI commands, no owner forms for them. Protection from
mistakes stays.

Removed with the decision (they were `src/server/owner-gate.ts` with its `RPC_CLASS` table, `src/server/protected-settings.ts`,
`src/server/secret-approval.ts`, `src/server/schedule-approvals.ts`, `src/anamnesis/access.ts` and `vk.rpcCallerPolicy`):

- the VK caller marks and the class of every RPC method (read / mutate / sensitive), so a call from the page, `bb`, an agent session, another plugin
  or plain `curl` is handled the same way;
- the owner's yes/no form for protected settings (`secrets.*`, `verification.sandbox_unsafe`, `sandbox.backend`, `integration.gate_command`), for
  schedule changes by the PM, for a secret name used by a check, and for anamnesis changes;
- the shell guard, PATH wrappers and OpenCode rules that refused `bb env-catalog get|set|delete|export|--raw`, the Env Catalog tools by role,
  `bb plugin rpc call` of Lane Pilot's settings, schedule and anamnesis methods, and `bb lane-pilot configure|budget|host-*|schedule|anamnesis`.

Kept (protection from mistakes, not from an agent):

- the shell guard against destructive commands (`rm`/`unlink` go to `agent-trash`, force pushes, `DELETE` without `WHERE`), and for writers and
  helpers `bb plugin config|token|disable|enable|reload|remove|safe-mode` and ssh/scp/sftp/rsync to the hub (`lane-stack/hooks/guard_shell.py`,
  `src/bb-shim.ts`, `src/opencode-min-config.ts`: the three lists are equal);
- the `schedule_origin` rule: a thread started by a schedule cannot create or change schedules (a runaway loop);
- the anamnesis data design: sensitive records hidden unless asked for (`--include-sensitive`), masking before Jev, the cost cap of a pass;
- `secrets.allow` as a list that only narrows (empty: every name the task contract declares), the issuance journal (`secret_issuance`) and the
  masking of every secret value in outputs; a check with secrets has the open network like any other check;
- the schema, contract lint and validation of every input, drills, deploy rollback, the automatic incident-deploy basis, the canary.
