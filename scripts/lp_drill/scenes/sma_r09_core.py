"""Region 9 · Person and window, the bb-core window nodes of batch core-app — proofs of the region scene sma_r09 (docs/sma-evidence.md, «Trace choice»).

These nodes are the BB window itself (apps/app of bb-core): dialogs, the composer, the thread timeline, the sidebar list, the palette, the query client. Their
behaviour is drawn in a browser, so the scene cannot see it through the `bb` CLI or a plugin RPC: they are listed under `notProved` with that reason and
nothing is invented. Two of them end in a call the CLI makes too, and those are proved against the sandbox project (`LP sandbox OVH (drill)`) and undone:
  n792 «rename a project»      the window sends updateProject{id, name}; `bb project update --name` is the same call. Renamed, read back, restored.
  n803 «rename a conversation» the window sends updateThread{id, title}; `bb thread update --title` is the same call. Renamed, read back, restored.
The line proves the server half of the door (it takes the new name and keeps it), not the dialog; the dialog is the sibling test's.
If the hub does not answer, the node goes under `notProved` with the cause. Run: scripts/lp-drill.sh --scenario sma_r09 (this module adds its nodes to that scene).
"""
from __future__ import annotations

import json

from lp_drill.env import SANDBOX
from lp_drill.hub import bb
from lp_drill.prove import Proofs

NODES_CORE = ["n792", "n803"]

BROWSER_ONLY = "browser only: the node is a screen of the BB window (bb-core apps/app) and the bb CLI or a plugin RPC cannot see what it draws"
NOT_PROVED_CORE: dict[str, str] = {n: BROWSER_ONLY for n in (
    "n785", "n791", "n796", "n797", "n798", "n799", "n800", "n801", "n802", "n819", "n827", "n828", "n830", "n838", "n865", "n875", "n902", "n903", "n922", "n944")}


def _json(*args: str):
    rc, out, err = bb(*args, "--json", timeout=60)
    if rc != 0:
        raise RuntimeError(f"bb {' '.join(args[:3])} exit {rc}: {(err or out).strip()[:160]}")
    return json.loads(out)


def _rename_probe(node: str, read, write, label: str, proofs: Proofs, not_proved: dict[str, str]) -> None:
    """Rename through the CLI, read it back, put the old name back; prove the node on what was read."""
    try:
        before = read()
    except (RuntimeError, ValueError) as cause:
        not_proved[node] = f"needs the hub: {str(cause)[:160]}"
        return
    if not before:
        not_proved[node] = f"the sandbox has no {label} with a name to rename"
        return
    probe = f"{before} (rename probe)"
    try:
        write(probe)
        seen = read()
    finally:
        write(before)
    proofs.prove(node, seen == probe and read() == before, f"{label} {before!r} renamed to {seen!r} and restored to {read()!r}")


def prove_core(proofs: Proofs, tmp) -> None:
    for node in NODES_CORE:
        NOT_PROVED_CORE.pop(node, None)
    project = SANDBOX["project"]

    # n792 Rename a project: the new name is stored for that project id.
    def project_name() -> str:
        return _json("project", "show", project).get("name") or ""

    def set_project_name(name: str) -> None:
        _json("project", "update", project, "--name", name)

    _rename_probe("n792", project_name, set_project_name, "sandbox project", proofs, NOT_PROVED_CORE)

    # n803 Rename a conversation: the new title is stored for that thread id.
    try:
        threads = [t for t in _json("thread", "list", "--project", project) if t.get("title")]
    except (RuntimeError, ValueError) as cause:
        NOT_PROVED_CORE["n803"] = f"needs the hub: {str(cause)[:160]}"
        return
    if not threads:
        NOT_PROVED_CORE["n803"] = "the sandbox project has no thread with a title to rename"
        return
    thread = threads[0]["id"]

    def thread_title() -> str:
        return (_json("thread", "show", thread).get("thread") or {}).get("title") or ""

    def set_thread_title(title: str) -> None:
        _json("thread", "update", thread, "--title", title)

    _rename_probe("n803", thread_title, set_thread_title, "sandbox thread", proofs, NOT_PROVED_CORE)
