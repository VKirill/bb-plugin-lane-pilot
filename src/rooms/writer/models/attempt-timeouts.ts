export const ATTEMPT_WAIT_MAX_MS = 48 * 3_600_000;
export const ATTEMPT_WAIT_MAX_SEC = 48 * 3_600;
/** Owner word wait deadline (6 hours). */
export const OWNER_WORD_WAIT_SEC = 6 * 3_600;
/** Default silence threshold (seconds) before nudging a silent writer. */
export const WRITER_SILENCE_FALLBACK_SEC = 20 * 60;
/** Default writer question wait deadline (seconds). */
export const QUESTION_WAIT_FALLBACK_SEC = 2 * 3_600;
/** Matvey's two-condition stop deadlines (process exit vs work hand-back). */
export const STOP_EXIT_DEADLINE_SEC = 30;
export const STOP_HANDBACK_DEADLINE_SEC = 60;

