import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * The shell guard of Codex, OpenCode and Cursor helpers and writers (audit 2026-10-08 round 3, P0-2).
 *
 * The guard hook (lane-stack/hooks/guard_shell.py) runs inside Claude Code only: Codex has no pre-tool hook installed and the
 * OpenCode guard does not know `bb`, so `bb env-catalog set` went through for a writer on those providers. Until BB's server checks
 * the caller, every Lane Pilot thread on those providers gets a directory of wrappers at the front of its PATH: `bb`, `ssh`, `scp`
 * and `sftp`. A wrapper refuses what guard_shell.py refuses for a writer or helper and runs the real program for everything else
 * (the first one further down PATH, never itself). `rsync -e ssh` and `git` over ssh reach `ssh` through PATH, so they meet the
 * wrapper too.
 *
 * What it does not stop: an absolute path to bb, `node <bb>`, `curl` to the BB server, a script that calls bb by another name.
 * That is for the server to close; this is the cheap cut for the plain `bb ...` an agent types.
 *
 * Keep the deny list equal to `_bb_args_error` (strict) and `_HUB_HOST` in lane-stack/hooks/guard_shell.py.
 */
export const BB_SHIM_NAMES = ["bb", "ssh", "scp", "sftp"] as const;

// `@{` stands for the shell's dollar-brace, which a template literal would read as its own.
export const BB_SHIM_SCRIPT = String.raw`#!/bin/sh
# Lane Pilot guard wrapper (bb, ssh, scp, sftp): refuses what a Lane Pilot writer or helper may not do, runs the rest.
self=@{0##*/}
case "$0" in */*) here=$(cd "@{0%/*}" 2>/dev/null && pwd -P) ;; *) here="" ;; esac
deny() {
  echo "[env-guard] $1 is not available to Lane Pilot agents: the owner changes Env Catalog entries and Lane Pilot's settings (the Env Catalog tab, Lane Pilot settings), not an agent's shell. For a missing key use env_request or bb env-catalog request NAME; the owner gets a form." >&2
  exit 126
}
set -f
case "$self" in
  bb)
    words=" "
    raw=0
    for a in "$@"; do
      case "$a" in
        --raw|--raw=*) raw=1 ;;
        -*) ;;
        *[!A-Za-z0-9_.@:/=,+-]*) words="$words"_" " ;;
        *) words="$words$a " ;;
      esac
    done
    case "$words" in
      *" env-catalog set "*|*" env-catalog delete "*|*" env-catalog export "*|*" env-catalog import-machine-env "*) deny "bb env-catalog" ;;
      *" env-catalog "*) [ "$raw" = 1 ] && deny "bb env-catalog --raw" ;;
    esac
    case "$words" in
      *" plugin rpc call env-catalog "*) deny "bb plugin rpc call env-catalog" ;;
      *" plugin rpc call lane-pilot "*|*" plugin rpc call bb-plugin-lane-pilot "*)
        case "$words" in
          *" save_"*|*" reset_"*|*" set_"*|*" stack_install "*|*" stack_connect "*|*" stack_rollback "*|*" native_install_start "*|*" decide_rule_proposal "*|*" rule_set_audience "*|*" memory_record_delete "*|*" prepare_native_session "*)
            deny "bb plugin rpc call lane-pilot" ;;
        esac ;;
      *" plugin config "*|*" plugin token "*|*" plugin disable "*|*" plugin enable "*|*" plugin reload "*|*" plugin remove "*|*" plugin safe-mode "*) deny "bb plugin" ;;
      *" lane-pilot configure "*|*" lane-pilot budget "*|*" lane-pilot host-run-cli "*|*" lane-pilot host-install "*|*" lane-pilot host-rollback "*|*" lane-pilot host-connect-opencode "*|*" lane-pilot host-import-config "*) deny "bb lane-pilot" ;;
    esac ;;
  ssh|scp|sftp)
    for a in "$@"; do
      case "$a" in
        *ovh-main*|*ovh-vps*|*vechkasov-ovh*|*selfystudio-work*|*claude-dev-key*|*10.8.0.1*|*54.37.129.153*) deny "$self to the hub" ;;
      esac
    done ;;
esac
real=""
old_ifs=$IFS
IFS=:
for d in $PATH; do
  [ -n "$d" ] || continue
  [ "$(cd "$d" 2>/dev/null && pwd -P)" = "$here" ] && continue
  if [ -x "$d/$self" ] && [ ! -d "$d/$self" ]; then real="$d/$self"; break; fi
done
IFS=$old_ifs
if [ -z "$real" ]; then echo "$self: command not found" >&2; exit 127; fi
exec "$real" "$@"
`.replaceAll("@{", "${");

async function writeIfChanged(path: string, content: string): Promise<void> {
  if ((await readFile(path, "utf8").catch(() => null)) !== content) {
    const staging = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(staging, content, { mode: 0o755 });
    await rename(staging, path);
  }
  await chmod(path, 0o755);
}

export type BbShimResult = { dir: string; path: string };

/** Writes the wrappers under the plugin's data dir (never anywhere the owner works) and says the PATH a helper should run with. */
export async function prepareBbShim(input: { dataDir: string; path?: string }): Promise<BbShimResult> {
  const dir = join(input.dataDir, "bb-shim");
  await mkdir(dir, { recursive: true });
  for (const name of BB_SHIM_NAMES) await writeIfChanged(join(dir, name), BB_SHIM_SCRIPT);
  const rest = (input.path ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(":").filter((part) => part && part !== dir);
  return { dir, path: [dir, ...rest].join(":") };
}
