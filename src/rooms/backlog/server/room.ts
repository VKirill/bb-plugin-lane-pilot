import type { Room } from "../../contracts";
import { backlogMigrations } from "../migrations";
import { backlogSettings } from "../settings";
import { BACKLOG_USAGE, runBacklogCli } from "./handlers/backlog-cli";
import type { BacklogApi } from "./services/scanner";

export const room: Room<{ backlog: BacklogApi }> = {
  name: "backlog",
  migrations: backlogMigrations,
  settings: backlogSettings,
  cli: [
    {
      name: "backlog",
      summary: "A project's ready todos sorted for issue: issuable in queue order (estimate at most 13, dependencies done), to estimate, to split, blocked; --scan hands the next ones to the PMs now",
      usage: BACKLOG_USAGE,
      run: ({ services, args }) => runBacklogCli(services.backlog, args),
    },
  ],
};
