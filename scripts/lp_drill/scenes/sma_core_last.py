"""bb-core nodes, batch core-last: the last SMA nodes whose proof anchor points at bb-core (n469, n470, n660, n775, n1499, n1514).

Called from sma_core.py (`not_proved.update(prove_last(proofs, tmp))`); its receipt lists these nodes next to the earlier core batches.
- n1514 «Local product checkout nearby» (core install-sources parsePluginSource): read only, `bb plugin list --json` and `bb plugin source lane-pilot --json`.
  On the hub Lane Pilot itself runs from a local product checkout through a `path:` source; the scene checks that the source is that folder and the
  folder holds the Lane Pilot package.
- n470 «Could not start» (core plugin-runtime loadOne): read only, `bb plugin list --json`. When a plugin on the hub is in status `error`, its detail must
  carry the reason; when none is, the node is not proved (making a plugin fail to start is a change of the hub).
- n1499 «Skills .claude/skills/sma-*» is proved on Lane Pilot's own half: sma_core_last_probe.ts loads the plugin of the commit under drill on a fake host
  and reads the route tool's visible registry (no model, no hub write).
- n469 «Window entry link» (core vk-owner-auth registerVkOwnerRoutes, apps/cli owner login) is not proved here: owner login is off on the hub, see NOT_PROVED_LAST.
- n775 «Window assets» (core routes/plugins GET /plugins/:id/assets/:file): read only, one GET of Lane Pilot's built app.js through the hub's own URL (the one
  `bb` uses, BB_SERVER_URL) and one GET of a name that is not a built file; nothing is written.
- n660 «Codex launch arguments» (core provider-codex toCodexThreadPermissionSettings) is not proved here, see NOT_PROVED_LAST.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import urllib.error
import urllib.request
from pathlib import Path

from lp_drill.env import ROOT
from lp_drill.hub import bb as run_bb
from lp_drill.prove import Proofs

NODES_LAST = ["n470", "n775", "n1499", "n1514"]
PROBE_LAST = ROOT / "scripts/lp_drill/scenes/sma_core_last_probe.ts"
NOT_PROVED_LAST = {
    "n469": "owner login is off on the hub (BB_VK_OWNER_AUTH unset; `bb owner status`: login off, no key paired): the link and its ticket trade cannot be seen there",
    "n660": "the sandbox and approval policy the core derives are not readable through bb: `bb thread show` and `bb thread options` of a Codex thread carry neither, and its event log records only the requested permissionMode, never the sandbox or approval policy sent to Codex",
}


def _bbj(*args: str):
    rc, out, _ = run_bb(*args, "--json", timeout=120)
    if rc != 0:
        return None
    try:
        return json.loads(out)
    except ValueError:
        return None


def _hub_base() -> str | None:
    base = os.environ.get("LP_DRILL_HUB_URL") or os.environ.get("BB_SERVER_URL")
    if not base:
        _, out, _ = run_bb("--help", timeout=60)
        found = re.search(r"BB_SERVER_URL:\s*(\S+)", out)
        base = found.group(1) if found else None
    return base.rstrip("/") if base else None


def _get(url: str) -> tuple[int, str, bytes]:
    """One read-only GET: (status, content type, body); status 0 when the hub did not answer."""
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method="GET"), timeout=120) as answer:
            return answer.status, answer.headers.get("content-type", ""), answer.read()
    except urllib.error.HTTPError as error:
        return error.code, error.headers.get("content-type", ""), error.read()
    except (urllib.error.URLError, TimeoutError, OSError):
        return 0, "", b""


def prove_last(proofs: Proofs, tmp) -> dict[str, str]:
    """Prove what the hub and the probe show for batch core-last; returns {node: why} for what could not be seen."""
    not_proved = dict(NOT_PROVED_LAST)
    rows = _bbj("plugin", "list")
    rows = rows.get("plugins", []) if isinstance(rows, dict) else (rows or [])
    rows = [r for r in rows if isinstance(r, dict) and "id" in r]

    # n1514 Local product checkout nearby: Lane Pilot runs from a local folder named as its path: source, and the folder holds the Lane Pilot package.
    lp = next((r for r in rows if r["id"] == "lane-pilot"), None)
    src = _bbj("plugin", "source", "lane-pilot")
    if lp is None or not isinstance(src, dict):
        not_proved["n1514"] = "the hub did not answer `bb plugin list` / `bb plugin source lane-pilot` (or Lane Pilot is not installed there)"
    elif not str(lp.get("source", "")).startswith("path:"):
        not_proved["n1514"] = f"Lane Pilot on this hub is not installed from a local folder (source kind {str(lp.get('source', '')).split(':', 1)[0]}): nothing to see"
    else:
        root = Path(str(lp.get("rootDir", "")))
        try:
            manifest = json.loads((root / "package.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            manifest = {}
        same = lp["source"] == f"path:{root}" and src.get("requested") == src.get("resolved") == lp["source"]
        package = manifest.get("name") == "bb-plugin-lane-pilot" and isinstance(manifest.get("bb"), dict) and bool(manifest["bb"].get("server"))
        proofs.prove("n1514", same and package and lp.get("status") == "running",
                     f"lane-pilot {lp.get('version')} runs from {lp.get('sourceDisplay')}: source = that folder {same}, folder holds {manifest.get('name')} {manifest.get('version')} {package}, status {lp.get('status')}")

    # n470 Could not start: a plugin that failed to start is in status error with its reason as the detail.
    failed = [r for r in rows if r.get("status") == "error"]
    if not rows:
        not_proved["n470"] = "the hub did not answer `bb plugin list`"
    elif not failed:
        not_proved["n470"] = f"no plugin is in status error on the hub ({len(rows)} listed): a start failure cannot be made without changing the hub's plugins"
    else:
        explained = [r["id"] for r in failed if isinstance(r.get("statusDetail"), str) and r["statusDetail"].strip()]
        proofs.prove("n470", len(explained) == len(failed), f"{len(failed)} plugins in status error, {len(explained)} with a reason in the detail ({', '.join(sorted(explained)) or 'none'})")

    # n775 Window assets: the core serves the plugin's built window file through GET /plugins/:id/assets/:file; a name that is no built file is 404.
    base = _hub_base()
    if base is None:
        not_proved["n775"] = "no hub URL: BB_SERVER_URL is not set on this machine and `bb --help` does not show it"
    else:
        status, kind, body = _get(f"{base}/api/v1/plugins/lane-pilot/assets/app.js")
        other, _, _ = _get(f"{base}/api/v1/plugins/lane-pilot/assets/package.json")
        built = Path(str((lp or {}).get("rootDir", ""))) / "dist" / "app.js"
        same = built.is_file() and built.read_bytes() == body
        if status == 0:
            not_proved["n775"] = f"the hub did not answer at {base}"
        else:
            proofs.prove("n775", status == 200 and len(body) > 0 and "javascript" in kind and other == 404,
                         f"GET /api/v1/plugins/lane-pilot/assets/app.js: {status}, {len(body)} bytes, {kind}, same bytes as the plugin's dist/app.js {same}; assets/package.json: {other}")

    # n1499 The per-workflow entries an agent sees: the route tool names exactly the ready shipped graphs by id, no fragment or pipeline among them.
    done = subprocess.run(["npx", "--yes", "vite-node", str(PROBE_LAST)], cwd=ROOT, capture_output=True, text=True, timeout=900)
    try:
        seen = json.loads(done.stdout.strip().splitlines()[-1]).get("n1499", {})
    except (ValueError, IndexError, AttributeError):
        seen = {"threw": f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-200:]}"}
    if "threw" in seen:
        proofs.prove("n1499", False, str(seen["threw"]))
    else:
        listed, ready, hidden = seen.get("listed", []), seen.get("ready", []), seen.get("hidden", [])
        leaked = [w for w in listed if w in hidden]
        proofs.prove("n1499", bool(seen.get("registered")) and len(ready) > 10 and listed == ready and not leaked,
                     f"lane_pilot_route names {len(listed)} graphs by id, the catalog has {len(ready)} ready ones (same list {listed == ready}); fragments or pipelines named: {leaked or 'none'} of {len(hidden)}")
    return not_proved
