// Public API of rollback: the migrations only (storage imports them; the rest of the room is behind ./server so storage never loads it).
export { rollbackMigrations } from "./migrations";
export { appendTaskReceipt, getAttemptChange, listAttemptChanges, listTaskReceipts, type TaskReceiptState } from "./store";
export { recoveryState } from "./store";
