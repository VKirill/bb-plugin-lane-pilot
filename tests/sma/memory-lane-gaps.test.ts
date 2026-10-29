import { describe, it } from "vitest";

// Terminal lane-memory left these behind. Lane Pilot does not reproduce them; the map stays missing or partial until a decision says otherwise.
describe("memory behaviours the terminal client kept", () => {
  it.todo("[sma:m_rd_migration] Claude Lane removed 2026-10-30 (owner): v1 memory folders are not migrated; the hub corpus is the record");
  it.todo("[sma:m_draft_move] Claude Lane removed 2026-10-30 (owner): draft files are not moved into a corpus; a repeated claim does not overwrite");
  it.todo("[sma:m_extract] a multi-sentence claim is one record; a list inside the text is not refused");
  it.todo("[sma:k_lib_migrate] Claude Lane removed 2026-10-30 (owner): v1 to v2 preview is not run");
  it.todo("[sma:k_v_mem_migrate] Claude Lane removed 2026-10-30 (owner): the migrate command is not a hub operation");
  it.todo("[sma:k_v_catalog] Claude Lane removed 2026-10-30 (owner): no catalog of one card per git file");
  it.todo("[sma:k_lib_catalog] Claude Lane removed 2026-10-30 (owner): a file card is not built from file bytes and git");
  it.todo("[sma:k_st_catalog] Claude Lane removed 2026-10-30 (owner): catalog and task packs are not stored under .cls");
  it.todo("[sma:k_c_sessreport] Claude Lane removed 2026-10-30 (owner): SESSION_REPORT.md is not written; token usage is the session cost");
});
