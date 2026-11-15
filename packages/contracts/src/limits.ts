/**
 * One source file inlined into a packet or inspected for capabilities is capped at this size; a bigger file
 * (a dataset, CSV, log or generated output) is never snapshot — it is read bounded on site. Both
 * tasks/execution-packet.ts (read_first entries) and native-install/capabilities.ts (source inspection) read this
 * one constant so the two caps cannot drift apart.
 */
export const MAX_SOURCE_BYTES = 512 * 1024;
