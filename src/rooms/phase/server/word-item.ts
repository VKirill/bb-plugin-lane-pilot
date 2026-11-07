import { tableExists, type OwnerItemSweep } from "../../owner-waiting";

const PHASE_WORD_PREFIX = "phase-word:";

/** The owner-item key prefix of one phase's word asks: `phase-word:<phase>:`. */
export const phaseWordItemPrefix = (phaseId: string) => `${PHASE_WORD_PREFIX}${phaseId}:`;

/** The owner-item key of one word a phase waits for: `phase-word:<phase>:<turn>[:<wave>]`. */
export const phaseWordItemKey = (phaseId: string, turn: string, wave?: number | string) =>
  `${phaseWordItemPrefix(phaseId)}${turn}${wave !== undefined ? `:${wave}` : ""}`;

/** The phase is closed or stopped: its word's row goes. The lesson draft is asked exactly as the phase closes, so a closed phase is
 * its normal state: it leaves by the owner's word (Gemini F-006.1 remainder). */
export const phaseWordSweep: OwnerItemSweep = (db, item) => {
  if (!item.key.startsWith(PHASE_WORD_PREFIX) || item.key.endsWith(":lesson") || !tableExists(db, "lane_pilot_phase")) return null;
  const phase = db.prepare("SELECT state FROM lane_pilot_phase WHERE id=?").get(item.key.split(":")[1]) as { state: string } | undefined;
  return !phase || phase.state === "closed" || phase.state === "stopped" ? "janitor:phase closed" : null;
};
