export const WORK_KINDS = ["routine", "employee", "project"] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

export function workKindOf(kind?: WorkKind | null): WorkKind {
  return kind ?? "routine";
}
