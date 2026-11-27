// Public API of owner-presence: reading the owner's presence marks and the hold they put on a provider.
export { JOURNAL_KEEP_DAYS, JOURNAL_MAX_ROWS, PRESENCE_WINDOW_MS, journalAppend, laneOwnedMetadata, outsideWorkSummary, presenceHold, readPresence } from "./models/presence";
export type { JournalRow, Presence } from "./models/presence";
