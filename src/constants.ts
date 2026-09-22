export const TARGET_SHA = "747a9ff9b2fa4ffdcf5c65c8d07eff2b9386a821";
export const UPSTREAM_REPO = "https://github.com/VKirill/claude-lane-stack";
export const OPENCODE_PLUGIN = "./plugins/opencode-lane.ts";
export const OPENCODE_OLD_PLUGIN = "./plugins/lane-context.ts";

export const S8_RELATIVE_PATHS = [
  ".agents/routing.profile.yaml",
  ".agents/night-shift.yaml",
  ".agents/capabilities.json",
] as const;

export const EXTERNAL_OPS = [
  "npm install -g @rama_nigg/open-cursor",
  "open-cursor install",
  "claude plugin marketplace add/update",
  "claude plugin install lane-stack@claude-lane-stack",
  "claude plugin uninstall fast-jev-compaction@*",
] as const;

export const EXTERNAL_OPS_WARNING =
  "откат не гарантированно вернёт систему в исходное состояние — будет зафиксировано состояние до и после, не восстановление";

export const PLUGIN_ID = "lane-pilot";
