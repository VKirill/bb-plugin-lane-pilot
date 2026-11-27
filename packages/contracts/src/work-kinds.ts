export const WORK_KINDS = ["routine", "employee", "project"] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

export function isWorkKind(value: unknown): value is WorkKind {
  return typeof value === "string" && (WORK_KINDS as readonly string[]).includes(value);
}

export function workKindOf(kind?: WorkKind | null): WorkKind {
  return kind ?? "routine";
}
