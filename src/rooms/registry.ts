import type { Room, RoomCliVerb } from "./contracts";
import type { ServerCore } from "./contracts/server";
import { room as checkers } from "./checkers/server";
import { room as lead } from "./lead/server";
import { room as baseline } from "./baseline/server";
import { room as front } from "./front/server";
import { room as specialist } from "./specialist/server";
import { room as coverage } from "./coverage";
import { room as settings } from "./settings/server";
import { room as writer } from "./writer/server";
import { room as runs } from "./runs/server";
import { room as tasks } from "./tasks/server";
import { room as workGraph } from "./work-graph/server";
import { room as workflow } from "./workflow/server";
import { room as memory } from "./memory/server";
import { room as memoryEval } from "./memory-eval/server";
import { room as memoryProbe } from "./memory-probe/server";
import { room as memoryTiers } from "./memory-tiers/server";
import { room as verification } from "./verification/server";
import { room as worktree } from "./worktree/server";
import { room as critique } from "./critique/server";
import { room as nativeInstall } from "./native-install/server";
import { room as nativeAgent } from "./native-agent/server";
import { room as stability } from "./stability/server";
import { room as docs } from "./docs/server";
import { room as usage } from "./usage/server";
import { room as platform } from "./platform/server";
import { room as deferral } from "./deferral/server";
import { room as backlog } from "./backlog/server";
import { room as outage } from "./outage/server";
import { room as projectGit } from "./project-git/server";
import { room as reports } from "./reports/server";
import { room as secrets } from "./secrets/server";
import { room as errands } from "./errands/server";
import { room as relay } from "./relay/server";
import { room as ownerWaiting } from "./owner-waiting/server";
import { room as rollback } from "./rollback/server";
import { room as qa } from "./qa/server";
import { room as stageReturn } from "./stage-return/server";
import { room as forecast } from "./forecast/server";
import { room as schedule } from "./schedule/server";
import { room as ownerPresence } from "./owner-presence/server";
import { room as fileCards } from "./file-cards/server";
import { room as money } from "./money/server";
import type { Services } from "./services";

/**
 * Every room that offers the plugin something to register (RPC handlers, `bb lane-pilot` verbs, PM tools, startup work).
 * Deleting a room is deleting its folder and its line here; nothing else names it. A room not listed registers nothing and
 * is on NOT_YET_REGISTERED in tests/architecture/room-registry.test.ts until it is converted.
 */
export const rooms: readonly Room<Services>[] = [
  checkers,
  lead,
  baseline,
  front,
  specialist,
  coverage,
  settings,
  writer,
  runs,
  tasks,
  workGraph,
  workflow,
  memory,
  memoryEval,
  memoryProbe,
  memoryTiers,
  verification,
  worktree,
  critique,
  nativeInstall,
  nativeAgent,
  stability,
  docs,
  usage,
  platform,
  deferral,
  backlog,
  outage,
  projectGit,
  reports,
  secrets,
  errands,
  relay,
  ownerWaiting,
  rollback,
  qa,
  stageReturn,
  forecast,
  schedule,
  ownerPresence,
  fileCards,
  money,
];

/** Typed settings contributed by registered rooms (in registry order). */
export const registeredRoomSettings = rooms.flatMap((entry) => entry.settings ?? []);

/** The RPC handlers of every room, one object; a key offered by two rooms is a start-up error, not a silent override. */
export function roomRpcHandlers(ctx: ServerCore, services: Services): Record<string, unknown> {
  const handlers: Record<string, unknown> = {};
  const owner = new Map<string, string>();
  for (const room of rooms) {
    const own = room.rpc ? room.rpc(ctx, services) : {};
    for (const [key, handler] of Object.entries(own)) {
      if (owner.has(key)) throw new Error(`rpc key ${key} is offered by rooms ${owner.get(key)} and ${room.name}`);
      owner.set(key, room.name);
      handlers[key] = handler;
    }
    ctx.bb.log.info(`rooms.registered name=${room.name} rpc=${Object.keys(own).length} cli=${room.cli?.length ?? 0} tools=${room.tools ? 1 : 0}`);
  }
  return handlers;
}

export const roomCliVerbs: readonly RoomCliVerb<Services>[] = rooms.flatMap((room) => room.cli ?? []);
