import type { Room } from "../../contracts";
import { CHECKERS_USAGE, runCheckersCli } from "./handlers/checkers-cli";
import type { CheckersApi } from "./services/checkers-api";

export const room: Room<{ checkers: CheckersApi }> = {
  name: "checkers",
  cli: [{ name:"checkers", summary:"Checking the checkers: plant known defects in accepted candidates, run every checker on them and print the checker scorecard (score, scorecard, drill, defects)", usage:CHECKERS_USAGE, run: ({ services, args }) => runCheckersCli(services.checkers, args) }],
};
