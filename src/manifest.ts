import { EXTERNAL_OPS } from "./constants";

export type ManifestKind = "file" | "tree" | "symlink" | "external";

export type ManifestRow = {
  id: string;
  path: string;
  kind: ManifestKind;
};

export const MANIFEST_ROWS: ManifestRow[] = [
  { id: "winnow-env", path: "~/.winnow/env", kind: "file" },
  { id: "sr-config", path: "~/.config/sr/config.toml", kind: "file" },
  { id: "npm-open-cursor", path: EXTERNAL_OPS[0], kind: "external" },
  { id: "open-cursor-install", path: EXTERNAL_OPS[1], kind: "external" },
  { id: "opencode-lane-ts", path: "~/.config/opencode/plugins/opencode-lane.ts", kind: "file" },
  { id: "opencode-lane-dir", path: "~/.config/opencode/plugins/opencode-lane", kind: "tree" },
  { id: "lane-context-ts", path: "~/.config/opencode/plugins/lane-context.ts", kind: "file" },
  { id: "opencode-lane-md", path: "~/.config/opencode/commands/opencode-lane.md", kind: "file" },
  { id: "opencode-json", path: "~/.config/opencode/opencode.json", kind: "file" },
  { id: "opencode-jsonc", path: "~/.config/opencode/opencode.jsonc", kind: "file" },
  { id: "claude-settings", path: "~/.claude/settings.json", kind: "file" },
  { id: "agents-bin", path: "~/.agents/bin", kind: "tree" },
  { id: "agents-board", path: "~/.agents/board", kind: "tree" },
  { id: "agents-docs", path: "~/.agents/docs", kind: "tree" },
  { id: "agents-hooks", path: "~/.agents/hooks", kind: "tree" },
  { id: "agents-templates", path: "~/.agents/templates", kind: "tree" },
  { id: "agents-skills", path: "~/.agents/skills", kind: "tree" },
  { id: "agents-pm-skills", path: "~/.agents/pm-skills", kind: "tree" },
  { id: "agents-schemas", path: "~/.agents/schemas", kind: "tree" },
  { id: "agents-agents", path: "~/.agents/agents", kind: "tree" },
  { id: "agents-agy", path: "~/.agents/agy", kind: "tree" },
  { id: "agents-grok", path: "~/.agents/grok", kind: "tree" },
  { id: "agents-codex", path: "~/.agents/codex", kind: "tree" },
  { id: "agents-seo-system", path: "~/.agents/seo-system", kind: "tree" },
  { id: "agents-profiles", path: "~/.agents/profiles", kind: "tree" },
  { id: "claude-agents", path: "~/.claude/agents", kind: "tree" },
  { id: "claude-skills", path: "~/.claude/skills", kind: "tree" },
  { id: "claude-commands", path: "~/.claude/commands", kind: "tree" },
  { id: "codex-home", path: "~/.codex", kind: "tree" },
  { id: "grok-config", path: "~/.grok/config.toml", kind: "file" },
  { id: "gemini-agy-writer", path: "~/.gemini/config/agents/agy-writer", kind: "tree" },
  { id: "gemini-lane-coder", path: "~/.gemini/config/agents/lane-coder", kind: "symlink" },
  { id: "gemini-lane-frontend", path: "~/.gemini/config/agents/lane-frontend", kind: "symlink" },
  { id: "gemini-lane-reviewer", path: "~/.gemini/config/agents/lane-reviewer", kind: "symlink" },
  { id: "gemini-consult", path: "~/.gemini/config/agents/consult", kind: "symlink" },
  { id: "marketplace-link", path: "~/.claude/plugins/marketplaces/claude-lane-stack", kind: "symlink" },
  { id: "known-marketplaces", path: "~/.claude/plugins/known_marketplaces.json", kind: "file" },
  { id: "claude-plugin-marketplace", path: EXTERNAL_OPS[2], kind: "external" },
  { id: "claude-plugin-install", path: EXTERNAL_OPS[3], kind: "external" },
  { id: "claude-plugin-uninstall", path: EXTERNAL_OPS[4], kind: "external" },
  { id: "bashrc", path: "~/.bashrc", kind: "file" },
  { id: "zshrc", path: "~/.zshrc", kind: "file" },
  { id: "codex-night-review", path: "~/.codex/night-review.config.toml", kind: "file" },
  { id: "codex-lane-writer", path: "~/.codex/lane-writer.config.toml", kind: "file" },
  { id: "opencode-agents", path: "~/.config/opencode/agents", kind: "tree" },
  { id: "install-json", path: "~/.agents/install.json", kind: "file" },
  { id: "routing-profile", path: "~/.agents/routing.profile.yaml", kind: "file" },
  { id: "night-shift", path: "~/.agents/night-shift.yaml", kind: "file" },
  { id: "capabilities", path: "~/.agents/capabilities.json", kind: "file" },
  { id: "guard-shell", path: "~/.agents/hooks/guard_shell.py", kind: "file" },
];
