"""Per-node proof of a drill scene (docs/sma-evidence.md): a scene proves a map node only when it asserted that node's
expected result and wrote it down in its receipt entry as `proved: [{node, ok, detail}]`. A scene that merely passed proves nothing."""
from __future__ import annotations

import re

from lp_drill.report import verdict

NODE_ID = re.compile(r"^n\d{1,5}$")


class Proofs:
    """One scene's list of proofs. `prove(node, ok, detail)` records one; `verdict(name, problems)` is the scene's entry:
    a false `ok` fails the scene with a problem line naming the node, and a scene that proved nothing fails too."""

    def __init__(self) -> None:
        self.items: list[dict] = []

    def prove(self, node: str, ok: bool, detail: str) -> bool:
        """Record that map node `node` was checked and `ok` says whether it gave its expected result; `detail` says what was seen
        («leak scan returned []»). The detail is evidence for a person: write the observed value, not the word «ok»."""
        if not NODE_ID.match(node or ""):
            raise ValueError(f"prove(): {node!r} is not a map node id (n1036)")
        if any(item["node"] == node for item in self.items):
            raise ValueError(f"prove(): node {node} is proved twice in one scene; fold the checks into one ok")
        self.items.append({"node": node, "ok": bool(ok), "detail": str(detail)[:300]})
        return bool(ok)

    def problems(self) -> list[str]:
        failed = [f"{item['node']}: not proved, {item['detail']}" for item in self.items if not item["ok"]]
        return failed or ([] if self.items else ["the scene proved no node (prove() was never called)"])

    def verdict(self, name: str, problems: list[str] | None = None, **details) -> dict:
        return verdict(name, [*(problems or []), *self.problems()], proved=self.items, **details)
