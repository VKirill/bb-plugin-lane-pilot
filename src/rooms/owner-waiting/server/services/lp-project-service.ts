import { resolveLanePilotProject } from "../../../platform/server";
import { closeOwnerItem, postOwnerItem } from "./owner-items-service";

const NO_LP_PROJECT_KEY = "lane-pilot:no-project";

/**
 * resolveLanePilotProject plus the owner's notice: `lane-pilot:no-project` stays open while neither the stored
 * config nor a matching source names the project, and closes itself when one does.
 */
export async function lanePilotProjectOrNotice(db: unknown, bb: unknown, host: unknown): Promise<{ projectId: string; environmentId: string } | null> {
  const found = await resolveLanePilotProject(bb, host);
  if (found) closeOwnerItem(db as never, NO_LP_PROJECT_KEY, "platform: resolved");
  else {
    postOwnerItem(db as never, {
      key: NO_LP_PROJECT_KEY,
      source: "platform",
      kind: "no_project",
      reason: "blocked",
      what: "Lane Pilot cannot find its own project",
      why: "self-repair:config names no projectId and no project source shares this plugin's repository remote.",
    });
  }
  return found;
}
