/**
 * Setting keys shared by the catalog rows and the rooms that read or write them; consumers import the
 * name instead of spelling the literal. Keys without a catalog row (webhook, worker, install receipt)
 * still live here so the read and the write cannot drift.
 */
export const SETTING_WRITER_SILENCE_NUDGE_MIN = "writer.silence_nudge_min";
export const SETTING_WRITER_CAPACITY_WAIT_MAX_MIN = "writer.capacity_wait_max_min";
export const SETTING_EVENTS_WEBHOOK_URL = "events.webhook_url";
export const SETTING_JEV_PROVIDER = "jev.provider";
export const SETTING_WORKER_STRICT_USER = "worker.strict_user";
export const SETTING_WORKER_USER = "worker.user";
export const SETTING_INSTALL_LAST_RECEIPT = "install.lastReceipt";
export const SETTING_EPISODES_PROCESS_KEY = "episodes.process_key";
