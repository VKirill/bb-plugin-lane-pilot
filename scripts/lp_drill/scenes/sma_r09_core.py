"""Region 9 · Person and window, the bb-core window nodes of batch core-app — proofs of the region scene sma_r09 (docs/sma-evidence.md, «Trace choice»).

These nodes are the BB window itself (apps/app of bb-core): dialogs, the composer, the thread timeline, the sidebar list, the palette, the query client. Their
behaviour is drawn in a browser, so the scene cannot see it through the `bb` CLI or a plugin RPC: they are listed under `notProved` with that reason and
nothing is invented. n792 «rename a project» and n803 «rename a conversation» are listed there too: their mutated code is the window's actions provider
(ProjectActionsProvider / ThreadActionsProvider), and a `bb project|thread update` rename reaches the server directly without running it, so a CLI
rename would be a trace from the wrong layer. Nothing is renamed and nothing is written to the hub.
Run: scripts/lp-drill.sh --scenario sma_r09 (this module adds its nodes to that scene).
"""
from __future__ import annotations

from lp_drill.prove import Proofs

NODES_CORE = ["n792", "n803"]

BROWSER_ONLY = "browser only: the node is a screen of the BB window (bb-core apps/app) and the bb CLI or a plugin RPC cannot see what it draws"
NOT_PROVED_CORE: dict[str, str] = {n: BROWSER_ONLY for n in (
    "n785", "n791", "n796", "n797", "n798", "n799", "n800", "n801", "n802", "n819", "n827", "n828", "n830", "n838", "n865", "n875", "n902", "n903", "n922", "n944")}


def prove_core(proofs: Proofs, tmp) -> None:
    """No prove(): the window's actions provider runs only in the BB window, and the CLI rename that the scene used to run bypassed it."""
    NOT_PROVED_CORE["n792"] = ("window component not executed: the mutated code is ProjectActionsProvider (bb-core apps/app); "
                               "`bb project update --name` reaches the server directly and bypasses it")
    NOT_PROVED_CORE["n803"] = ("window component not executed: the mutated code is ThreadActionsProvider (bb-core apps/app); "
                               "`bb thread update --title` reaches the server directly and bypasses it")
