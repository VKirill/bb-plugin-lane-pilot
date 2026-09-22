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

export const SETTING_CATALOG: SettingSpec[] = [
  { key:"writer.provider", channel:"W-DIRECT", flag:"--provider", subcommands:["run","start"] },
  { key:"writer.model", channel:"W-DIRECT", flag:"--model", subcommands:["run","start"] },
  { key:"writer.reasoning_effort", channel:"W-DIRECT", flag:"--reasoning-effort", subcommands:["run","start"] },
  { key:"writer.service_tier", channel:"W-DIRECT", flag:"--service-tier", subcommands:["run","start"] },
  { key:"writer.fast_mode", channel:"W-DIRECT", flag:"--fast-mode", booleanFlag:true, subcommands:["run","start"] },
  { key:"jev.LANE_JEV_EFFORT", channel:"ENV-PASSTHROUGH", env:"LANE_JEV_EFFORT" },
  { key:"jev.LANE_OPENCODE_JEV", channel:"ENV-PASSTHROUGH", env:"LANE_OPENCODE_JEV" },
  { key:"ops.max_tasks", channel:"OPS-DIRECT", flag:"--max-tasks", binaries:["lane-ctl"], subcommands:["start"] },
  { key:"ops.poll_interval", channel:"OPS-DIRECT", flag:"--poll-interval", binaries:["run-controller"], subcommands:["run","start"] },
  { key:"ops.heartbeat_interval", channel:"OPS-DIRECT", flag:"--heartbeat-interval", binaries:["run-controller"], subcommands:["run","start"] },
  { key:"ops.retry_backoff", channel:"OPS-DIRECT", flag:"--retry-backoff", binaries:["run-controller"], subcommands:["run","start"] },
  { key:"ops.run_dir", channel:"OPS-DIRECT", flag:"--run-dir" },
  { key:"ops.project_cwd", channel:"OPS-DIRECT", flag:"--project-cwd", subcommands:["run","start"] },
  { key:"ops.max_tasks_controller", channel:"OPS-DIRECT", flag:"--max-tasks", binaries:["run-controller"], subcommands:["run","start"] },
  {
    key:"plan_critique.mode",
    channel:"NONE",
    reason:"plan-critique argparse has no --mode; task-v2 has no such field (E1)",
  },
  {
    key:"plan_critique.enabled",
    channel:"NONE",
    reason:"plan-critique argparse has no --enabled flag",
  },
  {
    key:"plan_critique.provider",
    channel:"NONE",
    reason:"plan-critique argparse has no --provider",
  },
  {
    key:"plan_critique.model",
    channel:"NONE",
    reason:"plan-critique argparse has no --model",
  },
  {
    key:"night_review.model",
    channel:"NONE",
    reason:"night-shift has --provider but no --model",
  },
  {
    key:"night_review.reasoning_effort",
    channel:"NONE",
    reason:"night-shift has no --reasoning-effort",
  },
];

export function specFor(key: string): SettingSpec | undefined {
  return SETTING_CATALOG.find((row) => row.key === key);
}
