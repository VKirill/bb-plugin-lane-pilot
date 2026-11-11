// Public API of owner-presence: reading the owner's presence marks and the hold they put on a provider.
export { JOURNAL_KEEP_DAYS, PRESENCE_FILE, PRESENCE_WINDOW_MS, journalAppend, laneOwnedMetadata, outsideWorkSummary, presenceHold, readPresence } from "./logic";
export type { JournalRow, Presence } from "./logic";
