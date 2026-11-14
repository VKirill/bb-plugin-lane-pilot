// Stages and gates that are not a map node's own trace but showed no refusal in 30 days (hollow sign 6): a mutation
// test on the stage's current commit shows it CAN refuse. Keyed `stage:<stage id>` or `gate:<gate name>`.
// A map node attests through its own evidence line (`hollowAttested`); this list is for the rest.
import type { HollowAttest } from "./types";

export const STAGE_ATTESTED: Readonly<Record<string, HollowAttest>> = {
};
