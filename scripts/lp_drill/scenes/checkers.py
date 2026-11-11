"""The checkers gate: every lane-stack checker the repo registers still passes."""
from __future__ import annotations

import json

from lp_drill.env import ROOT
from lp_drill.hub import run
from lp_drill.report import verdict

def scenario_checkers(tmp: Path) -> dict:
    """The checker drill (src/rooms/checkers): planted defects, the code checkers must catch the class they are for. The checkout's own code is
    bundled and run, so a change that makes a checker blind turns the drill red before it is deployed. Then the same drill with the ownership
    checker blinded must come out red, or the drill proves nothing."""
    esbuild = ROOT / "node_modules/.bin/esbuild"
    command = [str(esbuild)] if esbuild.exists() else ["npx", "--no-install", "esbuild"]
    out = ROOT / "node_modules/.cache/lp-checkers-drill.mjs"
    out.parent.mkdir(parents=True, exist_ok=True)
    banner = "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);"
    rc, stdout, stderr = run([*command, str(ROOT / "scripts/lp-checkers.ts"), "--bundle", "--platform=node", "--format=esm", f"--outfile={out}",
                              "--external:better-sqlite3", "--external:@get-bb/plugin-sdk", f"--banner:js={banner}"], timeout=120)
    if rc != 0:
        return verdict("checkers", [f"the checker drill could not be built: {(stderr or stdout).strip()[:300]}"])
    problems: list[str] = []
    details: dict = {}
    for blind in (None, "ownership"):
        args = ["node", str(out), "drill", "--json"] + (["--blind", blind] if blind else [])
        rc, stdout, stderr = run(args, timeout=180)
        try:
            report = json.loads(stdout)
        except ValueError:
            problems.append(f"the checker drill{' (blind: ' + blind + ')' if blind else ''} gave no report: {(stderr or stdout).strip()[:300]}")
            continue
        if not blind:
            details = {"checked": report.get("checked")}
            if not report.get("ok"):
                problems += [f"checker drill: {p}" for p in report.get("problems", [])] or ["the checker drill is red without saying why"]
        elif report.get("ok") or not any(blind in p for p in report.get("problems", [])):
            problems.append(f"the checker drill stayed green with the {blind} checker blinded: the drill can no longer fail, so it proves nothing")
    return verdict("checkers", problems, **details)
