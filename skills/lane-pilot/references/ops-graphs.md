# A graph failed, accepted work is wrong, the owner decides

1. `lane_pilot_workflow_status` (runId): which step, its receipt, its output.
2. **A failed step may already have acted.** `budget_exceeded:*` after a send, a payment or a post means the money or time
   ran out *after* the step; the act may be done. Check the target (read the chat, the invoice, the page) **before** you tell
   the owner nothing happened and before any rerun. Never rerun an outgoing step without that check.
3. `lane_pilot_workflow_amend` (rerun) reruns that node **and every step after it**, sends and payments included. Before it, check
   the target of every step after the node that already acted; one that already sent means you do not rerun, you report. Goals that
   cannot be met: fix the work or, on the owner's word, the goals. A writer task's graph is not rerun this way: dispatch again.
4. A form waits for the owner: it is in this chat; remind him in one line, do not answer for him.


## 4. Accepted work is wrong later

- What the task changed and on which base: `bb lane-pilot changes <task-id>`.
- Its checks again on its base: `bb lane-pilot reverify <task-id>`.
- Undo it safely (checked, through the merge queue): `bb lane-pilot revert <task-id> --dry-run`, then without `--dry-run`.


## 5. Only the owner can decide

`bb lane-pilot waiting` lists what is his, with the exact action. A deferral he must give a term to: `bb lane-pilot deferrals`;
close one with evidence: `bb lane-pilot defer-close <id> --evidence <commit, test, link>`.

