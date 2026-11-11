"""The register of deferrals against the skips this checkouts tests cite."""
from __future__ import annotations

import re
from pathlib import Path

from lp_drill.env import ROOT
from lp_drill.hub import setting_rpc, RPC_MISSING
from lp_drill.report import verdict

DEFERRAL_MARK = re.compile(r"//\s*deferral:(dfr_[A-Za-z0-9_]+)")
def cited_deferrals() -> list[str]:
    """Every `// deferral:<id>` written in tests/ and packages/*/tests/ of this checkout (a skipped test names the entry that excuses it)."""
    found: set[str] = set()
    folders = [ROOT / "tests", *sorted((ROOT / "packages").glob("*/tests"))]
    for folder in folders:
        for path in folder.rglob("*"):
            if path.suffix not in (".ts", ".tsx", ".mts") or "node_modules" in path.parts:
                continue
            found.update(DEFERRAL_MARK.findall(path.read_text(encoding="utf-8", errors="replace")))
    return sorted(found)


def scenario_deferrals(tmp: Path) -> dict:
    """The register of deferrals (SMA rule 5): an entry whose term has passed, or a skipped test citing an entry the register does not hold
    or holds closed, fails the drill. Only a term an owner's message named can pass: an entry without one is «open, no term» and never overdue."""
    cited = cited_deferrals()
    try:
        data = setting_rpc("deferral_list", {"refs": cited})
    except Exception as cause:
        if RPC_MISSING.search(str(cause)):
            return verdict("deferrals", [], registerDeployed=False, note=f"the running plugin has no register yet: {str(cause)[:160]}")
        return verdict("deferrals", [f"the register of deferrals could not be read: {str(cause)[:200]}"])
    problems: list[str] = []
    for item in data.get("overdue", []):
        problems.append(f"overdue deferral {item['id']} ({item['kind']}: {item['what'][:100]}): its term {item['due']} passed. "
                        f"Do one of: do it and close it with evidence (bb lane-pilot defer-close {item['id']} --evidence \"<commit, test run, link>\"), "
                        f"or take a new date from the owner (bb lane-pilot defer {item['id']} --owner-msg <threadId>#<seq>)")
    for ref in data.get("badRefs", []):
        why = "is not in the register" if ref["problem"] == "unknown" else "is closed, so the skip it excuses is no longer deferred (run the test or remove the skip)"
        problems.append(f"a skipped test cites deferral:{ref['id']}, which {why}")
    counts = data.get("counts", {})
    return verdict("deferrals", problems, registerDeployed=True, counts=counts, cited=len(cited), needsOwnerTerm=len(data.get("needsOwnerTerm", [])))
