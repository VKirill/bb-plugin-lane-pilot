export const CHANNELS = ["W-DIRECT", "OPS-DIRECT", "ENV-PASSTHROUGH", "INSTALL-ENV", "OWN", "NONE"] as const;
export type Channel = (typeof CHANNELS)[number];
export type CliBinary = "run-controller" | "lane-ctl";

export type SettingSpec = {
  key: string;
  channel: Channel;
  flag?: string;
  env?: string;
  booleanFlag?: boolean;
  /** store_true / no --no-* flag: false cannot be applied as argv. */
  positiveOnly?: boolean;
  offFlag?: string;
  binaries?: CliBinary[];
  subcommands?: string[];
  reason?: string;
};

export const UNAPPLIED_REASON = {
  noChannel: "no proven runtime channel",
  noConsumer: "stored key has no runtime consumer",
  installNotCli: "INSTALL-ENV applies on install.sh/host-worker, not this CLI binary",
  planCritiqueMode: "plan-critique argparse has no --mode; task-v2 has no such field (E1)",
  planCritiqueEnabled: "plan-critique argparse has no --enabled flag",
  planCritiqueProvider: "plan-critique argparse has no --provider",
  planCritiqueModel: "plan-critique argparse has no --model",
  nightReviewModel: "night-shift has --provider but no --model",
  nightReviewEffort: "night-shift has no --reasoning-effort",
  booleanOffUnsupported: "upstream argparse is store_true; false has no off flag (bin/run-controller:1703-1707, bin/lane-ctl:3196-3200)",
  legacyFastModeMigrated: "legacy writer.fast_mode is diagnostic only; its value migrates to writer.service_tier",
} as const;

export function unappliedNotValidReason(spec: SettingSpec, binary: CliBinary, subcommand: string): string {
  return `${spec.channel} flag ${spec.flag ?? spec.env} is not valid on ${binary} ${subcommand}`;
}

export const SETTING_CATALOG: SettingSpec[] = [
  { key:"writer.provider", channel:"W-DIRECT", flag:"--provider", subcommands:["run","start"] },
  { key:"writer.model", channel:"W-DIRECT", flag:"--model", subcommands:["run","start"] },
  { key:"writer.reasoning_effort", channel:"W-DIRECT", flag:"--reasoning-effort", subcommands:["run","start"] },
  { key:"writer.service_tier", channel:"W-DIRECT", flag:"--service-tier", subcommands:["run","start"] },
  { key:"writer.agent", channel:"OWN", reason:"Native Lane Pilot writer role label; bounded and included in the BB writer prompt" },
  { key:"sandbox.backend", channel:"OWN", reason:"Native Lane Pilot verification selects Seatbelt on macOS or bubblewrap on Linux and fails closed when unavailable" },
  { key:"pm_read.enabled", channel:"OWN", reason:"Native Lane Pilot PM-read stage enable switch" },
  { key:"pm_read.min_lines", channel:"OWN", reason:"Native Lane Pilot PM-read minimum input size" },
  { key:"pm_read.provider", channel:"OWN", reason:"Native Lane Pilot PM-read provider selection" },
  { key:"pm_read.model", channel:"OWN", reason:"Native Lane Pilot PM-read model selection" },
  { key:"pm_read.reasoning_effort", channel:"OWN", reason:"Native Lane Pilot PM-read reasoning effort" },
  { key:"pm_read.service_tier", channel:"OWN", reason:"Native Lane Pilot PM-read service tier" },
  { key:"helper.placement", channel:"OWN", reason:"Native Lane Pilot control for where newly spawned helper threads appear: hidden in the plugin or visible in the parent project tree" },
  { key:"helper.context_mode", channel:"OWN", reason:"Native Lane Pilot helper session filter: inherit, selected allowlists, or empty optional lists" },
  { key:"helper.skills", channel:"OWN", reason:"Native Lane Pilot helper skills allowlist when helper.context_mode is selected" },
  { key:"helper.mcp_servers", channel:"OWN", reason:"Native Lane Pilot helper MCP allowlist when helper.context_mode is selected" },
  { key:"helper.bb_plugins", channel:"OWN", reason:"Native Lane Pilot helper BB-plugin allowlist when helper.context_mode is selected" },
  { key:"helper.native_plugins", channel:"OWN", reason:"Native Lane Pilot helper native-plugin allowlist when helper.context_mode is selected" },
  { key:"writer.fast_mode", channel:"NONE", reason:UNAPPLIED_REASON.legacyFastModeMigrated },
  { key:"jev.LANE_JEV_EFFORT", channel:"ENV-PASSTHROUGH", env:"LANE_JEV_EFFORT" },
  { key:"jev.LANE_OPENCODE_JEV", channel:"ENV-PASSTHROUGH", env:"LANE_OPENCODE_JEV" },
  { key:"ops.max_tasks", channel:"OPS-DIRECT", flag:"--max-tasks", binaries:["lane-ctl"], subcommands:["start"] },
  { key:"ops.poll_interval", channel:"OPS-DIRECT", flag:"--poll-interval", binaries:["run-controller"], subcommands:["run","start","watch"] },
  { key:"ops.heartbeat_interval", channel:"OPS-DIRECT", flag:"--heartbeat-interval", binaries:["run-controller"], subcommands:["run","start"] },
  { key:"ops.retry_backoff", channel:"OPS-DIRECT", flag:"--retry-backoff", binaries:["run-controller"], subcommands:["run","start"] },
  { key:"ops.run_dir", channel:"OPS-DIRECT", flag:"--run-dir" },
  { key:"ops.project_cwd", channel:"OPS-DIRECT", flag:"--project-cwd", subcommands:["run","start","verify","accept"] },
  { key:"ops.task_id", channel:"OPS-DIRECT", flag:"--task-id", binaries:["lane-ctl"], subcommands:["start","status","tail","events","cancel","retry","fallback"] },
  { key:"ops.task_file", channel:"OPS-DIRECT", flag:"--task-file", binaries:["lane-ctl"], subcommands:["start","verify","accept"] },
  { key:"ops.idle", channel:"OPS-DIRECT", flag:"--idle", binaries:["lane-ctl"], subcommands:["start"] },
  { key:"ops.max_runtime", channel:"OPS-DIRECT", flag:"--max-runtime", binaries:["lane-ctl"], subcommands:["start"] },
  { key:"ops.pool_size", channel:"OPS-DIRECT", flag:"--pool-size", binaries:["lane-ctl"], subcommands:["start"] },
  { key:"ops.verify_pool_size", channel:"OPS-DIRECT", flag:"--verify-pool-size", binaries:["lane-ctl"], subcommands:["verify"] },
  { key:"ops.command_timeout", channel:"OPS-DIRECT", flag:"--command-timeout", binaries:["lane-ctl"], subcommands:["verify"] },
  { key:"ops.watch_timeout", channel:"OPS-DIRECT", flag:"--timeout", binaries:["run-controller"], subcommands:["watch"] },
  { key:"ops.tail_source", channel:"OPS-DIRECT", flag:"--source", binaries:["lane-ctl"], subcommands:["tail"] },
  { key:"ops.tail_lines", channel:"OPS-DIRECT", flag:"--lines", binaries:["lane-ctl"], subcommands:["tail"] },
  { key:"ops.events_limit", channel:"OPS-DIRECT", flag:"--limit", binaries:["lane-ctl"], subcommands:["events"] },
  { key:"install.LANE_INSTALL_LOCAL_MARKETPLACE", channel:"INSTALL-ENV", env:"LANE_INSTALL_LOCAL_MARKETPLACE" },
  { key:"install.LANE_INSTALL_CLAUDE_PLUGIN", channel:"INSTALL-ENV", env:"LANE_INSTALL_CLAUDE_PLUGIN" },
  { key:"install.CLAUDE_CONFIG_DIR", channel:"INSTALL-ENV", env:"CLAUDE_CONFIG_DIR" },
  { key:"install.CODEX_HOME", channel:"INSTALL-ENV", env:"CODEX_HOME" },
  {
    key:"plan_critique.mode",
    channel:"OWN",
    reason:"Native Lane Pilot stage setting; upstream CLI has no --mode argument",
  },
  {
    key:"plan_critique.enabled",
    channel:"OWN",
    reason:"Native Lane Pilot stage setting; upstream CLI has no --enabled argument",
  },
  { key:"plan_critique.provider", channel:"OWN", reason:"Native Lane Pilot stage plan-critique provider setting; not sent to an upstream CLI" },
  { key:"plan_critique.model", channel:"OWN", reason:"Native Lane Pilot stage plan-critique model setting; not sent to an upstream CLI" },
  { key:"plan_critique.reasoning_effort", channel:"OWN", reason:"Native Lane Pilot stage plan-critique effort setting; not sent to an upstream CLI" },
  { key:"plan_critique.service_tier", channel:"OWN", reason:"Native Lane Pilot stage plan-critique tier setting; not sent to an upstream CLI" },
  { key:"plan_critique.agent", channel:"OWN", reason:"Native Lane Pilot plan-critique role label included in its prompt" },
  { key:"plan_critique.min_score", channel:"OWN", reason:"Native Lane Pilot critique threshold applied to the task-risk score adapter" },
  { key:"plan_critique.min_write_tasks", channel:"OWN", reason:"Native Lane Pilot critique threshold applied to the persisted run TaskV2 lane count" },
  { key:"plan_critique.on_high_risk", channel:"OWN", reason:"Native Lane Pilot critique policy enables dispatch for high or critical task risk" },
  { key:"code_critique.enabled", channel:"OWN", reason:"Native Lane Pilot post-writer code critique; default off keeps legacy acceptance" },
  { key:"code_critique.mode", channel:"OWN", reason:"Native Lane Pilot advisory records findings; gate blocks final acceptance on changes_requested" },
  { key:"code_critique.provider", channel:"OWN", reason:"Native Lane Pilot independent code-critique reviewer provider" },
  { key:"code_critique.model", channel:"OWN", reason:"Native Lane Pilot independent code-critique reviewer model" },
  { key:"code_critique.reasoning_effort", channel:"OWN", reason:"Native Lane Pilot independent code-critique reviewer effort" },
  { key:"code_critique.service_tier", channel:"OWN", reason:"Native Lane Pilot independent code-critique reviewer tier" },
  { key:"code_critique.agent", channel:"OWN", reason:"Native Lane Pilot code-critique role label included in its prompt" },
  { key:"code_critique.auto_fix", channel:"OWN", reason:"Native Lane Pilot returns actionable findings to the original writer for a bounded repair round" },
  { key:"code_critique.max_rounds", channel:"OWN", reason:"Native Lane Pilot maximum automatic writer repair rounds after code critique, capped at 3" },
  { key:"browser_qa.enabled", channel:"OWN", reason:"Native Lane Pilot stage Browser QA enabled setting; not sent to an upstream CLI" },
  { key:"browser_qa.provider", channel:"OWN", reason:"Native Lane Pilot stage Browser QA provider setting; not sent to an upstream CLI" },
  { key:"browser_qa.model", channel:"OWN", reason:"Native Lane Pilot stage Browser QA model setting; not sent to an upstream CLI" },
  { key:"browser_qa.reasoning_effort", channel:"OWN", reason:"Native Lane Pilot stage Browser QA effort setting; not sent to an upstream CLI" },
  { key:"browser_qa.backend", channel:"OWN", reason:"Native Lane Pilot stage Browser QA backend setting; not sent to an upstream CLI" },
  { key:"browser_qa.approve", channel:"OWN", reason:"Native Lane Pilot stage Browser QA approval setting; not sent to an upstream CLI" },
  { key:"specialist.enabled", channel:"OWN", reason:"Native Lane Pilot stage setting: specialist review" },
  { key:"specialist.when", channel:"OWN", reason:"Native Lane Pilot stage setting: specialist review" },
  { key:"specialist.provider", channel:"OWN", reason:"Native Lane Pilot stage setting: specialist review" },
  { key:"specialist.model", channel:"OWN", reason:"Native Lane Pilot stage setting: specialist review" },
  { key:"specialist.reasoning_effort", channel:"OWN", reason:"Native Lane Pilot stage setting: specialist review" },
  { key:"specialist.agent", channel:"OWN", reason:"Native Lane Pilot specialist role label included in its prompt" },
  { key:"adoc.040", channel:"OWN", reason:"Native Lane Pilot stage setting: workspace routing and managed-worktree lifecycle" },
  { key:"adoc.041", channel:"OWN", reason:"Native Lane Pilot task workspace router risk threshold" },
  { key:"adoc.042", channel:"OWN", reason:"Native Lane Pilot task workspace router multi-output isolation switch" },
  { key:"run.gate", channel:"OWN", reason:"Native Lane Pilot snapshots the run gate and stops automated dispatch for operator review" },
  { key:"docs.enabled", channel:"OWN", reason:"Native Lane Pilot stage setting: execute bounded docs maintenance" },
  { key:"docs.maintain", channel:"OWN", reason:"Native Lane Pilot stage setting: enable or pause docs edits" },
  { key:"docs.page_cap", channel:"OWN", reason:"Native Lane Pilot stage setting: maximum Markdown pages passed to docs maintainer" },
  { key:"docs.since", channel:"OWN", reason:"Native Lane Pilot stage setting: age window for docs candidates" },
  { key:"docs.hour", channel:"OWN", reason:"Native Lane Pilot stage setting: local hour for the daily docs schedule" },
  { key:"docs.provider", channel:"OWN", reason:"Native Lane Pilot docs stage uses validated BB provider selection" },
  { key:"docs.model", channel:"OWN", reason:"Native Lane Pilot docs stage uses validated BB model selection" },
  { key:"docs.reasoning_effort", channel:"OWN", reason:"Native Lane Pilot docs stage uses model-supported reasoning selection" },
  { key:"docs.service_tier", channel:"OWN", reason:"Native Lane Pilot docs stage uses provider-supported service tier selection" },
  { key:"docs.agent", channel:"OWN", reason:"Native Lane Pilot docs role label included in its prompt" },
  { key:"onboarding.provider", channel:"OWN", reason:"Native Lane Pilot onboarding preview uses validated BB provider selection" },
  { key:"onboarding.model", channel:"OWN", reason:"Native Lane Pilot onboarding preview uses validated BB model selection" },
  { key:"onboarding.reasoning_effort", channel:"OWN", reason:"Native Lane Pilot onboarding preview uses model-supported reasoning selection" },
  { key:"onboarding.service_tier", channel:"OWN", reason:"Native Lane Pilot onboarding preview uses provider-supported service tier selection" },
  { key:"onboarding.agent", channel:"OWN", reason:"Native Lane Pilot onboarding role label included in the preview prompt" },
  { key:"onboarding.depth", channel:"OWN", reason:"Native Lane Pilot onboarding preview depth controls its prompt scope" },
  { key:"memory.enabled", channel:"OWN", reason:"Native Lane Pilot stage setting: enable isolated project memory maintenance and injection" },
  { key:"memory.provider", channel:"OWN", reason:"Native Lane Pilot stage uses the BB provider/model selection for project memory maintenance" },
  { key:"memory.maintain", channel:"OWN", reason:"Native Lane Pilot stage setting: maintain durable project memory after accepted work" },
  { key:"memory.inject", channel:"OWN", reason:"Native Lane Pilot stage setting: retrieve bounded relevant project memory for a writer" },
  { key:"memory.audience", channel:"OWN", reason:"Native Lane Pilot stage setting: control memory audience" },
  { key:"memory.personal_bot", channel:"OWN", reason:"Native Lane Pilot keeps bot-scoped project memory isolated across maintenance and retrieval" },
  { key:"memory.search_engine", channel:"OWN", reason:"Native Lane Pilot stage setting: choose FTS5 or BM25 retrieval" },
  { key:"memory.core_budget", channel:"OWN", reason:"Native Lane Pilot stage setting: cap core memory tokens" },
  { key:"memory.note_budget", channel:"OWN", reason:"Native Lane Pilot stage setting: cap note memory tokens" },
  { key:"memory.index_budget", channel:"OWN", reason:"Native Lane Pilot stage setting: cap total project index tokens" },
  { key:"memory.context_budget", channel:"OWN", reason:"Native Lane Pilot stage setting: cap injected memory context tokens" },
  { key:"memory.agent", channel:"OWN", reason:"Native Lane Pilot memory role label included in its prompt" },
  { key:"night_review.enabled", channel:"OWN", reason:"Native Lane Pilot stage setting: enable the bounded post-acceptance night reviewer" },
  { key:"night_review.auto_merge", channel:"OWN", reason:"Native Lane Pilot stage setting: merge only a verified, approved PR in a managed worktree" },
  { key:"night_review.max_fix_tasks", channel:"OWN", reason:"Native Lane Pilot stage setting: cap actionable night-review fixes to 1-10" },
  { key:"night_review.provider", channel:"OWN", reason:"Native Lane Pilot stage uses the BB ProviderModelPicker for night review" },
  { key:"night_review.model", channel:"OWN", reason:"Native Lane Pilot stage uses the BB ProviderModelPicker for night review" },
  { key:"night_review.agent", channel:"OWN", reason:"Native Lane Pilot stage consumes this reviewer role label in its prompt" },
  {
    key:"night_review.model",
    channel:"NONE",
    reason: UNAPPLIED_REASON.nightReviewModel,
  },
];

export const CONSUMER_KEYS = new Set(
  SETTING_CATALOG.filter((row) => row.channel !== "NONE").map((row) => row.key),
);

export function specFor(key: string): SettingSpec | undefined {
  return SETTING_CATALOG.find((row) => row.key === key);
}
