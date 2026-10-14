Context: task pm-remind-tool-removal removes the PM's reminder tool. Reminder data showed PMs used time reminders to poll councils (council.ts told them to remind in 20 min) and workflow runs, since neither tells the PM it ended.

Steps:
1. [x] council.ts: in the session runner after the decision page is written and handoffs created (around the decisionPath block), send one message to input.pmThreadId via bb.sdk.threads.send({threadId, mode:"queue-if-active", input:[{type:"text", text, mentions:[]}]}). Also when the session ends without a decision. Mark it sent (council row state or KV) so a reload does not resend.
2. [x] Workflow: find where lane_pilot_wf_run status becomes terminal/blocked (workflow.ts / workflow-executors.ts). On that transition, if the run has a PM thread (linked pm_thread_id) and was not started by a schedule, send one message with run id, workflow id, status, reason, goalAudit unmet ids. Mark sent per (run, status).
3. [x] Update native-agent-overlay.ts and bundled-agents.json (kept identical; tests/pm-instructions.test.ts checks) and council start instructions: end the turn after start; the end arrives by itself.
4. [x] Tests in tests/server/pm-notices.test.ts with fake bb.sdk.threads.send; run verification.
