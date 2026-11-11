import type { DirtSnapshot } from "../cli-outcome";
import type { PrototypeConfig, TaskV2 } from "../../contracts";

/** A writer's environment from Lane Pilot's own provider (H9), over a worktree Lane Pilot already made. */
export type ProviderEnvironment = { type:"provider"; environmentProviderId:string; inputs:{basePath:string;name:string;path:string;ownsBarrier?:boolean;ownsPaths?:string[];neverTouch?:string[]}; machine:{type:"existing";hostId:string} };

export type WriterEnvironment = ProviderEnvironment | {type:"reuse";environmentId:string} | {type:"host";hostId:string;workspace:{type:"unmanaged";path:string}};

export type SpawnInput = {
    projectId:string; runId:string; taskId:string; attemptId:string;
    config:PrototypeConfig; task:TaskV2; plan:string; pmThreadId:string; pmReadContext?:string;
    /** A fallback writer: its model, and its effort when it is one of the writer's fallbacks (the PM's model has none). */
    emergency?:{providerId:string;model:string;reason:string;reasoningLevel?:string}; retryIndex?:number;
    /** The previous attempt's failure, for a retry (`previousAttemptBrief`). */
    previousAttempt?:string;
    /** The writer the start chose for this task (Jev's pick or the rotation's share): read here over the stored settings, or the pick is lost. */
    writerSettings?:Record<string, unknown>;
    /**
     * A fallback that continues an interrupted attempt: it works in that attempt's worktree with the edits left there, against
     * the dirt baseline the attempt was measured with, and starts from the handoff brief.
     */
    continuation?:{workspacePath:string; environmentId:string|null; dirtBefore:DirtSnapshot[]; fromThreadId:string; brief:string};
};
export type SpawnResult =
    | { ok:true; threadId:string; providerId:string|null; model:string|null; reasoningLevel?:string; serviceTier?:"default"|"fast"|null; selectionSource?:{providerId:string;model:string;reasoningLevel:string;serviceTier:"default"|"fast"|null;reasoningLevelSource:"explicit"|"client-preference"}; dirtBefore:import("../cli-outcome").DirtSnapshot[]; workspacePath:string; executionPacketSha256?:string }
    | { ok:false; status:"spawn_rejected" | "canceled" | "blocked"; reason:string; attemptId:string };
