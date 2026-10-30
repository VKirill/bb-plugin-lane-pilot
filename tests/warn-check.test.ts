import { it } from "vitest";
import { loadWorkflow, validateWorkflow } from "@lane-pilot/workflow-engine";
import { readFileSync } from "node:fs";
it("warn dump", () => {
  for (const f of ["3d-asset","ui-audit","ship","cleanup","seo-page"]) {
    const l = loadWorkflow(JSON.parse(readFileSync(`workflows/${f}.json`,"utf8")));
    if (l.ok) console.log(f, JSON.stringify(validateWorkflow(l.workflow).filter(p=>p.node==="goal_check"||p.code)));
  }
});
