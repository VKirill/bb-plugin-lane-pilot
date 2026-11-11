/** How long a task waits for a blocked dependency to be sent again and accepted. */
/** How long a task waits for an Env Catalog secret, and how often it asks the catalog (BB sends no server-side event when it changes). */
export const SECRET_WAIT_MS = 12 * 3600_000;
/** The run.max_* setting behind each budget kind, for the owner item's «raise the limit» action (sma ac_pocket). */
export const RUN_LIMIT_WORD = { maxAttempts:"число попыток", maxWallMs:"время работы в минутах", maxTokens:"токены", maxChildren:"число помощников" } as const;
export const RUN_LIMIT_SETTING = { maxAttempts:"run.max_attempts", maxWallMs:"run.max_wall_minutes", maxTokens:"run.max_tokens", maxChildren:"run.max_children" } as const;
export const secretPollMs = () => Number(process.env.LANE_PILOT_SECRET_POLL_MS) || 20_000;

/** How long a task waits for a canceled depends_on to be sent again (`<id>.2`) before it gives up. */
export const CANCELED_REDO_WAIT_MS = 20 * 60_000;
