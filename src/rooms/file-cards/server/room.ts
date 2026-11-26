import type { Room } from "../../contracts";
import { CATALOG_USAGE, runCatalogCli } from "./handlers/cli";

export const room: Room = {
  name: "file-cards",
  cli: [{ name: "catalog", summary: "The file catalog: one card line per git-tracked file (path, size, language, last change, first line); --write stores it", usage: CATALOG_USAGE, run: ({ args, invocation }) => invocation?.threadId
    // The verb reads files of the machine the hub runs on: a chat on another machine must not read the hub's folders through it.
    ? Promise.resolve({ exitCode: 1, stderr: "refused: catalog reads folders of the hub machine and is for the owner at a terminal; a session builds its own catalog at start" })
    : runCatalogCli(args) }],
};
