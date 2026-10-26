import { z } from "zod";
import { literalCoverage, schemaEnums } from "@lane-pilot/kit/prompt-coverage";
import type { EnumGroup } from "@lane-pilot/kit/prompt-coverage";
import { artifactDef, artifactId } from "./artifacts";
import { outputContract } from "./agent-output";
import type { ProducesSpec } from "./artifacts";
import type { Field } from "./schema";

/** The enum members an artifact kind's schema accepts, each group with its path inside the schema. */
export function artifactEnums(kind: string, version: number): EnumGroup[] {
  const def = artifactDef(kind, version);
  return def ? schemaEnums(z.toJSONSchema(def.schema, { unrepresentable: "any", io: "input" })) : [];
}

/**
 * Vocabulary an agent step is held to but its prompt may never say: the enum members of the artifacts it `produces`. The
 * engine checks the answer against the kind's schema (`severity` is one of five words, `status` one of three) when the step
 * ends. The step's own `out` fields need no check: `outputContract` lists every enum member of them in the prompt the engine
 * sends, so the texts compared here are the node's prompt and that contract. Gates are printed by the start packet.
 */
export function promptCoverageProblems(node: { id: string; prompt: string; produces?: readonly ProducesSpec[] | undefined }, fields: readonly Field[]): string[] {
  const texts = [node.prompt, outputContract(fields)];
  const problems: string[] = [];
  for (const spec of node.produces ?? []) {
    for (const group of artifactEnums(spec.kind, spec.version)) {
      const { missing, partial } = literalCoverage(group.values, texts);
      if (missing.length) problems.push(`${node.id}: produces ${artifactId(spec)}, which accepts ${group.values.join(" | ")} at ${group.path}; the prompt ${partial ? "does not name" : "names none of them, missing"} ${missing.map((value) => `"${value}"`).join(", ")}`);
    }
  }
  return problems;
}
