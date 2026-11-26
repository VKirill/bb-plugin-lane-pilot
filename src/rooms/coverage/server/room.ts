import type { Room } from "../../contracts";
import { COVERAGE_USAGE, runCoverageCli } from "../cli";

export const room: Room = {
  name: "coverage",
  cli: [{ name:"coverage", summary:"What proves each pipeline stage, attempt transition, failure class, gate, memory path, room and key mechanism: covered live by a deploy-drill scenario, covered by tests only (and why no drill), or not covered; --receipt checks the live claims against a drill receipt", usage:COVERAGE_USAGE, fullHelp: true, run: ({ args }) => runCoverageCli(args) }],
};
