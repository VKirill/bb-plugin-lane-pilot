import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * The shell guard of Codex, OpenCode and Cursor helpers and writers (audit 2026-10-08 round 3, P0-2), cut down to protection from
 * mistakes (owner decision 2026-10-08: no gates against agents).
 *
 * The guard hook (lane-stack/hooks/guard_shell.py) runs inside Claude Code only: Codex has no pre-tool hook installed and the
 * OpenCode guard does not know `bb`. Every Lane Pilot thread on those providers gets a directory of wrappers at the front of its
 * PATH: `bb`, `ssh`, `scp` and `sftp`. A wrapper refuses what guard_shell.py refuses for a writer or helper (`bb plugin config|token|
 * disable|enable|reload|remove|safe-mode` and ssh/scp/sftp to the hub: both can break the hub by mistake) and runs the real program
 * for everything else (the first one further down PATH, never itself). `rsync -e ssh` and `git` over ssh reach `ssh` through PATH,
 * so they meet the wrapper too. Env Catalog, Lane Pilot settings, schedules and anamnesis are not fenced: those are the owner's
 * agents on the owner's machines.
 *
 * It is a net for a plain `bb ...` typed by mistake, not a wall: an absolute path to bb, `command -p bb`, `node <bb>` or a hub name
 * that only DNS resolves (the Python guard looks those up, this wrapper does not) get past it.
 *
 * The hub address is read in every notation `ssh` reads (10.8.0.1, 10.8.1, 0x0a080001, 168296449, 012.010.0.1, ::ffff:10.8.0.1,
 * ::ffff:a08:1): the wrapper turns the word into a number with the shell's own arithmetic.
 *
 * Keep the deny list equal to `_bb_args_error` (strict) and `_hub_target` in lane-stack/hooks/guard_shell.py.
 */
export const BB_SHIM_NAMES = ["bb", "ssh", "scp", "sftp"] as const;

// `@{` stands for the shell's dollar-brace, which a template literal would read as its own.
export const BB_SHIM_SCRIPT = String.raw`#!/bin/sh
# Lane Pilot guard wrapper (bb, ssh, scp, sftp): refuses what a Lane Pilot writer or helper may not do, runs the rest.
self=@{0##*/}
case "$0" in */*) here=$(cd "@{0%/*}" 2>/dev/null && pwd -P) ;; *) here="" ;; esac
deny() {
  echo "[hub-guard] $1 is not available to Lane Pilot agents: it can break the hub or BB's plugin runtime by mistake. Ask the owner to run it in their own terminal." >&2
  exit 126
}
# 32-bit number of an IPv4 address in any inet_aton notation (a.b.c.d, a.b.c, a.b, a; decimal, 0x hex or 0 octal) in IPNUM; fails for anything else.
ipnum() {
  IPNUM=""
  case "$1" in ""|*[!0-9A-Fa-fxX.]*|.*|*..*|*.) return 1 ;; esac
  _o=$IFS; IFS=.; set -- $1; IFS=$_o
  _n=$#
  [ "$_n" -le 4 ] || return 1
  _t=0; _i=0; _m=16777216
  for _p in "$@"; do
    _i=$((_i + 1))
    [ "@{#_p}" -le 10 ] || return 1
    case "$_p" in
      0[xX]) _v=0 ;;
      0[xX]*) case "@{_p#??}" in *[!0-9A-Fa-f]*) return 1 ;; esac; _v=$((_p)) ;;
      0*) case "$_p" in *[!0-7]*) return 1 ;; esac; _v=$((_p)) ;;
      [1-9]*) case "$_p" in *[!0-9]*) return 1 ;; esac; _v=$((_p)) ;;
      *) return 1 ;;
    esac
    if [ "$_i" -lt "$_n" ]; then
      [ "$_v" -le 255 ] || return 1
      _t=$((_t + _v * _m)); _m=$((_m / 256))
    else
      case "$_n" in 1) _l=4294967296 ;; 2) _l=16777216 ;; 3) _l=65536 ;; *) _l=256 ;; esac
      [ "$_v" -lt "$_l" ] || return 1
      _t=$((_t + _v))
    fi
  done
  IPNUM=$_t
}
# The IPv4 number inside an IPv6 address (::ffff:a.b.c.d, ::ffff:xxxx:xxxx, the long forms) in IPNUM.
v6num() {
  IPNUM=""
  _c=@{1%%%*}
  case "$_c" in ""|*[!0-9a-f:.]*) return 1 ;; esac
  _last=@{_c##*:}
  case "$_last" in *.*) ipnum "$_last"; return ;; esac
  _rest=@{_c%:*}
  _hi=@{_rest##*:}
  [ -n "$_last" ] && [ "@{#_last}" -le 4 ] && [ "@{#_hi}" -le 4 ] || return 1
  case "$_last$_hi" in *[!0-9a-f]*) return 1 ;; esac
  IPNUM=$((0x$_last + 0x@{_hi:-0} * 65536))
}
# 0 when the (lower-cased) host is the hub: one of its names, 10.8.0.1 or 54.37.129.153 in any notation.
hub_candidate() {
  _h=$(printf '%s' "$1" | tr 'A-Z' 'a-z')
  case "$_h" in
    ovh-main|ovh-vps|vechkasov-ovh|selfystudio-work|claude-dev-key|rescue-vps) return 0 ;;
    *:*) v6num "$_h" || return 1 ;;
    *) ipnum "$_h" || return 1 ;;
  esac
  [ "$IPNUM" = 168296449 ] || [ "$IPNUM" = 908427673 ]
}
# One word of a command line: user@host, host:path, ssh://user@host:port/, [v6]:path, -oHostName=host, a,b (ProxyJump).
hub_word() {
  w=$1
  w=@{w#*://}
  w=@{w%%/*}
  w=@{w##*=}
  _o=$IFS; IFS=,; set -- $w; IFS=$_o
  for c in "$@"; do
    c=@{c##*@}
    case "$c" in \[*) c=@{c#\[}; c=@{c%%\]*} ;; esac
    case "$c" in *:*:*) ;; *:*) c=@{c%%:*} ;; esac
    c=@{c%.}
    hub_candidate "$c" && return 0
  done
  return 1
}
set -f
case "$self" in
  bb)
    words=" "
    for a in "$@"; do
      case "$a" in
        -*) ;;
        *[!A-Za-z0-9_.@:/=,+-]*) words="$words"_" " ;;
        *) words="$words$a " ;;
      esac
    done
    case "$words" in
      *" plugin config "*|*" plugin token "*|*" plugin disable "*|*" plugin enable "*|*" plugin reload "*|*" plugin remove "*|*" plugin safe-mode "*) deny "bb plugin" ;;
    esac ;;
  ssh|scp|sftp)
    for a in "$@"; do
      case "$a" in
        *ovh-main*|*ovh-vps*|*vechkasov-ovh*|*selfystudio-work*|*claude-dev-key*|*rescue-vps*|*10.8.0.1*|*54.37.129.153*) deny "$self to the hub" ;;
      esac
      for word in $a; do
        word=@{word#[\'\"]}
        word=@{word%[\'\"]}
        hub_word "$word" && deny "$self to the hub"
      done
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
