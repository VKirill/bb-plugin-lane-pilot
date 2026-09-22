#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.HOME;
const stack = process.env.STACK_ROOT;
const stopAfter = process.argv[2] ?? "";
if (!home || !stack) {
  console.error("HOME and STACK_ROOT are required");
  process.exit(2);
}

const dest = join(home, ".agents");
const claude = join(home, ".claude");
const marker = join(home, ".lane-pilot-phase");

function sh(command, args) {
  execFileSync(command, args, { stdio: "inherit", env: process.env });
}

function mark(name) {
  writeFileSync(marker, `${name}\n`);
  if (stopAfter === name) process.kill(process.pid, "SIGKILL");
}

mkdirSync(join(dest, "agy/instructions"), { recursive: true });
mkdirSync(join(dest, "grok/instructions"), { recursive: true });
mkdirSync(join(dest, "codex/instructions"), { recursive: true });
for (const name of ["bin", "board", "docs", "hooks", "templates", "skills", "pm-skills", "schemas", "agents"]) {
  mkdirSync(join(dest, name), { recursive: true });
}
mkdirSync(join(claude, "agents"), { recursive: true });
mkdirSync(join(claude, "skills"), { recursive: true });
mkdirSync(join(claude, "commands"), { recursive: true });
mkdirSync(join(home, ".codex"), { recursive: true });
mark("mkdir");

const filters = ["--exclude", "__pycache__/", "--exclude", "*.py[co]"];
sh("rsync", ["-a", ...filters, `${stack}/hooks/`, `${dest}/hooks/`]);
sh("rsync", ["-a", ...filters, `${stack}/templates/`, `${dest}/templates/`]);
sh("rsync", ["-a", ...filters, `${stack}/schemas/`, `${dest}/schemas/`]);
mark("rsync");

sh("python3", [
  join(dest, "hooks/merge_claude_settings.py"),
  join(claude, "settings.json"),
  join(dest, "hooks/guard_shell.py"),
  "--statusline", join(dest, "bin/lane-statusline"),
  "--session-mark", join(dest, "hooks/lane_statusline_session.py"),
  "--plugin-root", stack,
]);
mark("settings");

if (process.env.LANE_PILOT_CONFIRM_EXTERNAL === "1") {
  sh("npm", ["install", "-g", "@rama_nigg/open-cursor"]);
  mark("npm");
} else {
  writeFileSync(join(home, ".lane-pilot-npm-skipped"), "не применимо без подтверждения\n");
  mark("npm");
}

writeFileSync(join(dest, "install.json"), `${JSON.stringify({
  schema_version: 1,
  source_sha: process.env.TARGET_SHA ?? "phased",
  installed_at: new Date().toISOString(),
}, null, 2)}\n`);
mark("install_json");
