export const CHANNELS = ["W-DIRECT", "OPS-DIRECT", "ENV-PASSTHROUGH", "INSTALL-ENV", "NONE"] as const;
export type Channel = (typeof CHANNELS)[number];
export type CliBinary = "run-controller" | "lane-ctl";

export type SettingSpec = {
  key: string;
  channel: Channel;
  flag?: string;
  env?: string;
  booleanFlag?: boolean;
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
} as const;

export function unappliedNotValidReason(spec: SettingSpec, binary: CliBinary, subcommand: string): string {
  return `${spec.channel} flag ${spec.flag ?? spec.env} is not valid on ${binary} ${subcommand}`;
}

export const SETTING_CATALOG: SettingSpec[] = [
  { key:"writer.provider", channel:"W-DIRECT", flag:"--provider", subcommands:["run","start"] },
  { key:"writer.model", channel:"W-DIRECT", flag:"--model", subcommands:["run","start"] },
  { key:"writer.reasoning_effort", channel:"W-DIRECT", flag:"--reasoning-effort", subcommands:["run","start"] },
  { key:"writer.service_tier", channel:"W-DIRECT", flag:"--service-tier", subcommands:["run","start"] },
  { key:"writer.fast_mode", channel:"W-DIRECT", flag:"--fast-mode", booleanFlag:true, subcommands:["run","start"] },
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
    channel:"NONE",
    reason: UNAPPLIED_REASON.planCritiqueMode,
  },
  {
    key:"plan_critique.enabled",
    channel:"NONE",
    reason: UNAPPLIED_REASON.planCritiqueEnabled,
  },
  {
    key:"plan_critique.provider",
    channel:"NONE",
    reason: UNAPPLIED_REASON.planCritiqueProvider,
  },
  {
    key:"plan_critique.model",
    channel:"NONE",
    reason: UNAPPLIED_REASON.planCritiqueModel,
  },
  {
    key:"night_review.model",
    channel:"NONE",
    reason: UNAPPLIED_REASON.nightReviewModel,
  },
  {
    key:"night_review.reasoning_effort",
    channel:"NONE",
    reason: UNAPPLIED_REASON.nightReviewEffort,
  },
];

export const CONSUMER_KEYS = new Set(
  SETTING_CATALOG.filter((row) => row.channel !== "NONE").map((row) => row.key),
);

export function specFor(key: string): SettingSpec | undefined {
  return SETTING_CATALOG.find((row) => row.key === key);
}
