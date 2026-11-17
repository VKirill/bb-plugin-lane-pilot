"""The local R08 proofs, independently of the live registry check in sma_r08.

All local assertions run and any failure fails this scene. The receipt names only these eleven nodes;
n752 stays exclusively in the original scene, which retains its live registry semantics.
"""
from lp_drill.prove import Proofs
from lp_drill.report import verdict
from lp_drill.scenes.sma_r08 import prove_local

NODES = ["n678", "n685", "n704", "n731", "n732", "n733", "n734", "n735", "n737", "n742", "n749"]


def local_verdict(proofs: Proofs, problems: list[str]) -> dict:
    selected = [item for item in proofs.items if item["node"] in NODES]
    missing = [node for node in NODES if not any(item["node"] == node for item in selected)]
    errors = [*problems, *proofs.problems()]
    if missing:
        errors.append(f"local nodes not checked: {', '.join(missing)}")
    if any(item["node"] == "n752" for item in proofs.items):
        errors.append("the live registry node must not run in the local scene")
    return verdict("sma_r08_local", errors, proved=selected, checked=len(NODES),
                   notProved={"n752": "live registry check belongs to sma_r08; not run here"})


def scenario_sma_r08_local(tmp) -> dict:
    proofs = Proofs()
    return local_verdict(proofs, prove_local(tmp, proofs))
