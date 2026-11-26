import { mapListedQaHosts, type QaHostOption } from "../../models/qa-hosts";

/** The hosts BB knows, as the pickers list them. */
export async function listQaHosts(bb: { sdk: object }): Promise<QaHostOption[]> {
  const listed = await (bb.sdk as unknown as { hosts?: { list?: () => Promise<unknown> } }).hosts?.list?.() ?? [];
  return mapListedQaHosts(listed);
}
