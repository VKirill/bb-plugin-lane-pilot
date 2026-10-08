// Which room each source file belongs to (docs/architecture.md, "Rooms"). Paths are relative to src/ and written without
// extension; `server/x` and `ui/x` land in <room>/server/ and <room>/ui/, everything else in the room folder itself.
// A room is src/rooms/<room>/: index.ts (public domain API), server/index.ts, ui/index.ts, the rest is private.

const ROOMS: Record<string, string> = {
  contracts: `contracts`,
  core: `server/context server/core server/lifecycle-events server/native-wiring server/opencode-minimal server/pm-spawn server/realtime server/rpc
    server/rpc-timing server/schedules server/services server/thread-keys server/tool-result server/values server/host-jobs server/model-catalog-reader`,
  storage: `database workflow/draft-store workflow/files workflow/journal workflow/ops-store workflow/store`,
  runs: `acceptance-stats aggregation constants failure-class state-machine jev/failure-class-model jev/judgments/failure-class
    server/blocked-by server/cancel server/child-snapshots server/rpc/runs server/run-finish server/run-routing server/runs-halt server/stage-brief server/stage-records
    server/task-reconcile server/tasks-mirror ui/acceptance-stats ui/run-card ui/run-parts ui/runs-service ui/runs-window ui/stage-result`,
  writer: `argv-builder check-timing cli-flags cli-outcome cli-run live-folder retry-budget spawn-seam stage-writer-selection stream-retry writer-brief writer-fallbacks writer-reuse-stats
    server/checkout-guests server/concurrency-limit server/writer-host server/writer-silence server/writer-task
    server/writer/answer server/writer/dispatch server/writer/dispatch-workflow server/writer/finish server/writer/live-folder server/writer/spawn server/writer/start
    server/writer/state server/writer/sticky server/writer/update-task server/writer/verify ui/writer-reuse`,
  tasks: `acceptance-v2 task-stem task-v2 validate-output
    server/accepted-compact server/contract-lint server/lint-task stages/contract stages/execution-packet stages/gate-report stages/read-first stages/run-policy`,
  verification: `workspace-dirt
    server/bookkeeping-exclude server/gate-detect server/integration-gate server/merge-intent server/repo-edits stages/gate-triage
    verification/docs-data verification/docs-flows verification/docs-jev verification/docs-routes verification/git-docs verification/git-integrate verification/git-ownership
    verification/integration-gate-host verification/ownership verification/sandbox verification/stability-drill workspace/provider-gate workspace/routing`,
  critique: `critic-pair critic-stats
    server/critique-runs server/specialists stages/code-critique stages/critique stages/critique-coverage stages/model-json stages/pm-read stages/quality-mode stages/retry-effort
    stages/role stages/role-method stages/specialist stages/verdict ui/critic-value`,
  docs: `server/docs-nightly server/stages/docs stages/docs stages/docs-defaults stages/docs-lint stages/docs-worthiness ui/docs-places`,
  night: `server/stages/night stages/emergency-writer stages/night stages/night-fix`,
  qa: `qa-host server/errands server/stages/children server/stages/qa server/stages/qa-thread stages/browser-qa`,
  "project-life": `server/stages/onboarding server/stages/project-life stages/onboarding stages/project-life`,
  memory: `server/memory-mix server/memory-sync server/session-memory server/stages/memory stages/memory ui/memory-records`,
  relay: `owner-ask owner-ask-shared server/handoff server/owner-ask server/relay server/service-message ui/owner-ask`,
  council: `server/council ui/council-page`,
  stability: `reconcile server/canary server/deploy-drain server/health server/hook-timeouts server/probes server/provider-retry server/reconcile server/stability stages/opencode-telemetry`,
  "self-repair": `server/insights server/rpc/insights server/rule-scan server/self-repair ui/rule-proposals`,
  usage: `server/provider-usage server/rpc/token-usage server/token-usage ui/token-usage`,
  secrets: `server/rpc/secrets server/secrets`,
  settings: `enum-labels import-config setting-copy setting-validation
    server/rpc/preferences server/rpc/selections server/rpc/settings ui/agent-access ui/catalog-field ui/owned-settings ui/picker-selections ui/setting-controls`,
  tools: `pm-tool-families server/cli server/tool-families server/tool-presentation server/tools`,
  workflow: `workflow-architect server/architect-start server/rpc/workflow-ops server/rpc/workflows server/workflow server/workflow-agent server/workflow-agent-model server/workflow-architect
    server/workflow-executors server/workflow-goal-audit server/workflow-invoice server/invoice-pdf server/workflow-library server/workflow-models server/workflow-ops server/workflow-preflight
    server/workflow-router-model server/workflow-runtime server/workflow-step-executors server/workflow-tools server/workflow-triggers server/workflow-triggers-live
    jev/route-model jev/judgments/route-workflow
    workflow/actions workflow/agent-output workflow/artifacts workflow/builtin workflow/capabilities workflow/catalog workflow/contract workflow/cron workflow/draft workflow/draft-test
    workflow/draft-view workflow/edge-label workflow/engine workflow/expr workflow/goals workflow/handoff workflow/lower workflow/preflight workflow/reducers workflow/router
    workflow/run-stats workflow/schema workflow/validate workflow/values workflow/view workflow/view-core
    ui/architect-launch ui/elk-shim.d ui/workflow-actions ui/workflow-detail ui/workflow-draft ui/workflow-draft-detail ui/workflow-drafts ui/workflow-drill ui/workflow-edit-fields
    ui/workflow-edit-model ui/workflow-edit-panels ui/workflow-edit-state ui/workflow-graph ui/workflow-graph-parts ui/workflow-layout ui/workflow-model-ops ui/workflow-models
    ui/workflow-native-picker ui/workflow-node-data ui/workflow-run ui/workflow-titles ui/workflows`,
  "native-install": `external-ops guard-apply install-runner manifest native-hook-sources native-install-bootstrap native-install-host native-install-lifecycle native-install-owned
    opencode-connect opencode-min-config receipt s8 snapshot stack-ops upstream coexistence/cas coexistence/contracts coexistence/index coexistence/ownership server/rpc/stack
    upstream-adapter/capabilities upstream-adapter/opencode-plugin`,
  "native-agent": `activation agent-display agent-inventory agent-profile bb-shim bundled-agents.json composer-selection helper-context helper-placement native-agent-definition native-agent-id
    native-agent-overlay native-claude-host native-dispatch native-lane-reconcile native-run native-session native-session-hooks project-binding project-scope session-inventory thread-completion
    server/activation server/environment-provider server/helper-bb-shim server/helper-probe server/native-profile server/rpc/workspace-provider
    ui/composer-agent-badge ui/composer-enable ui/composer-prompt-box ui/composer-selection-hook ui/helper-threads ui/pending-native-agent ui/team-details ui/team-model`,
  "host-worker": `host-handlers jobs script-run`,
  schedule: `schedule/board schedule/contract schedule/errand-model schedule/model schedule/outcome schedule/scheduler schedule/store schedule/time schedule/views
    server/rpc/schedules server/schedule-cli server/schedule-default server/schedule-executors server/schedule-place server/schedule-service server/schedule-tools server/schedule-usage
    ui/schedule-board ui/schedule-calendar ui/schedule-default ui/schedule-detail ui/schedule-form ui/schedule-history ui/schedule-model ui/schedule-parts ui/schedule-text ui/schedule-who`,
  anamnesis: `anamnesis/card anamnesis/chain-actions anamnesis/cli anamnesis/collect anamnesis/contract anamnesis/daily anamnesis/extract anamnesis/host anamnesis/hub anamnesis/judgment
    anamnesis/load anamnesis/model anamnesis/ops anamnesis/owner-messages anamnesis/pii anamnesis/profile-import anamnesis/skills anamnesis/sources/common anamnesis/sources/docs
    anamnesis/sources/elba anamnesis/sources/git anamnesis/sources/memories anamnesis/sources/telegram anamnesis/store anamnesis/whoami anamnesis/wiring anamnesis/year-review
    ui/anamnesis-tab`,
  learning: `learning/cli learning/config learning/decide learning/digest learning/extract learning/frustration learning/housekeeping learning/judgment learning/keys learning/live
    learning/migrations learning/observe learning/opinion learning/ops learning/pm-rules learning/rule-budget learning/rules-port learning/service learning/signals learning/store`,
  "ui-shell": `ui/page ui/page-model ui/pill ui/placement ui/project-header ui/project-nav ui/segments ui/service-projects ui/tab-automation ui/tab-knowledge ui/tab-overview ui/tab-runs
    ui/tab-team ui/tab-work ui/tabs-model ui/use-lp-page ui/use-lp-realtime ui/how-it-works`,
};

export const ROOM_OF = new Map<string, string>();
for (const [room, list] of Object.entries(ROOMS)) {
  for (const item of list.split(/\s+/).filter(Boolean)) {
    if (ROOM_OF.has(item)) throw new Error(`${item} is in two rooms: ${ROOM_OF.get(item)} and ${room}`);
    ROOM_OF.set(item, room);
  }
}

/** Files whose name would clash inside their room, or is reserved for a face (index). */
const RENAME: Record<string, string> = {
  "jev/judgments/failure-class": "failure-class-judgment",
  "coexistence/index": "coexistence",
  contracts: "index",
  "coexistence/contracts": "coexistence-contracts",
};
const PURE_ORIGINS = /^(stages|verification|workflow|jev\/judgments|jev|coexistence|upstream-adapter|workspace|schedule|anamnesis|learning)\//;

/** src/<x> -> src/rooms/<room>/<x'>: server/ and ui/ keep their folder (server/writer and server/stages are flattened into it), the other origin folders are dropped. */
export function target(srcRel: string): { room: string; to: string } | null {
  const rest0 = srcRel.replace(/^src\//, "");
  const key = rest0.replace(/\.(ts|tsx)$/, "");
  const room = ROOM_OF.get(key) ?? ROOM_OF.get(rest0);
  if (!room) return null;
  const ext = rest0.slice(key.length);
  let rest: string;
  if (RENAME[key]) rest = RENAME[key] + ext;
  else if (key.startsWith("server/writer/")) rest = "server/" + rest0.slice("server/writer/".length);
  else if (key.startsWith("server/stages/")) rest = "server/" + rest0.slice("server/stages/".length);
  else if (key.startsWith("server/") || key.startsWith("ui/")) rest = rest0;
  else rest = rest0.replace(PURE_ORIGINS, "");
  return { room, to: `src/rooms/${room}/${rest}` };
}
