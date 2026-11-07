/** The closed list of cancel codes (W31 rank 6): every cancel names one, a caller that names none records `unknown`. The morning
 * summary's cancel Pareto reads `lane_pilot_attempt.cancel_code`. */
import { CANCEL_CODES, type CancelCode } from "@lane-pilot/contracts";
export { CANCEL_CODES, type CancelCode };

/** Stamps the cancel code on the attempt row; the first stamp wins (a request-time `reassign`/`owner_cancel` outranks the
 * generic `stuck` a recovery writes when it settles the request). NULL stays for cancels written before the codes existed. */
export function markCancelCode(db: { prepare(sql: string): { run(...args: unknown[]): unknown } }, attemptId: string, code: CancelCode): void {
  db.prepare("UPDATE lane_pilot_attempt SET cancel_code=COALESCE(cancel_code, ?) WHERE id=?").run(code, attemptId);
}
