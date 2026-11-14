// The per-node evidence of the whole map, merged from one file per region (r00.ts … r28.ts, SMA_REGIONS order) so
// that batch agents working on different regions never edit the same file. A node may appear only in its own
// region's file; tests/sma-evidence.test.ts fails on a node of another region, an unknown node or setting key, a
// malformed mutation spec and a trace that does not run on the real schema.
import type { NodeEvidence, RegionEvidence } from "./types";
import r00 from "./r00";
import r01 from "./r01";
import r02 from "./r02";
import r03 from "./r03";
import r04 from "./r04";
import r05 from "./r05";
import r06 from "./r06";
import r07 from "./r07";
import r08 from "./r08";
import r09 from "./r09";
import r10 from "./r10";
import r11 from "./r11";
import r12 from "./r12";
import r13 from "./r13";
import r14 from "./r14";
import r15 from "./r15";
import r16 from "./r16";
import r17 from "./r17";
import r18 from "./r18";
import r19 from "./r19";
import r20 from "./r20";
import r21 from "./r21";
import r22 from "./r22";
import r23 from "./r23";
import r24 from "./r24";
import r25 from "./r25";
import r26 from "./r26";
import r27 from "./r27";
import r28 from "./r28";

/** Region index → its evidence file. */
export const SMA_EVIDENCE_BY_REGION: readonly RegionEvidence[] = [r00, r01, r02, r03, r04, r05, r06, r07, r08, r09, r10, r11, r12, r13, r14, r15, r16, r17, r18, r19, r20, r21, r22, r23, r24, r25, r26, r27, r28];

/** Node id → evidence, all regions merged (a node in two files: the first wins, the test names the duplicate). */
export const SMA_EVIDENCE: Readonly<Record<string, NodeEvidence>> = Object.assign({}, ...[...SMA_EVIDENCE_BY_REGION].reverse());

export { STAGE_ATTESTED } from "./stages";
export type { HollowAttest, MutationKind, MutationSpec, NeedValue, NodeEvidence, ReachSpec, RegionEvidence, VoidReview } from "./types";
