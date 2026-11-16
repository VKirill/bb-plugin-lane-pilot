import { z } from "zod";

export const nativeSelectionSchema = z.object({
  token: z.string().uuid(),
  projectId: z.string().min(1),
  agentId: z.string().min(1).max(200),
  profileMode: z.enum(["installed", "session-override"]),
  agentsJson: z.string().max(200_000).nullable(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  // Optional keeps selections written before native diagnostics readable; new passports always carry it.
  sourceVersion: z.string().min(1).nullable().optional(),
  createdAt: z.number(),
  /** A PM's specialist thread: it works for this run and never opens a run of its own. */
  parentRunId: z.string().min(1).optional(),
}).strict();

export type NativeSelection = z.infer<typeof nativeSelectionSchema>;

export const nativeDiagnosticPointSchema = z.object({
  agentId: z.string().min(1),
  profileMode: z.union([z.enum(["installed", "session-override"]), z.literal("unknown")]),
  sourceVersion: z.string().min(1),
  sourceHash: z.string().min(1),
  providerId: z.string().min(1),
  model: z.string().min(1),
  effort: z.string().min(1),
  hostId: z.string().min(1),
  environmentId: z.string().min(1),
  path: z.string().min(1),
  observationBoundary: z.union([z.literal("unknown"), z.literal("host-preparation")]),
}).strict();

export const nativeDiagnosticsSchema = z.object({
  requested: nativeDiagnosticPointSchema,
  resolved: nativeDiagnosticPointSchema,
  /** The selected placement/model target, before a native launcher reports what became effective. */
  target: nativeDiagnosticPointSchema,
  effective: nativeDiagnosticPointSchema,
  observed: nativeDiagnosticPointSchema,
}).strict();

export type NativeDiagnosticPoint = z.infer<typeof nativeDiagnosticPointSchema>;
export type NativeDiagnostics = z.infer<typeof nativeDiagnosticsSchema>;

const UNKNOWN_NATIVE_DIAGNOSTIC = "unknown";

/** Build one honest diagnostic point. Callers override only values they actually obtained from a boundary. */
export function nativeDiagnosticPoint(
  selection: Pick<NativeSelection, "agentId" | "profileMode" | "sourceVersion" | "sourceHash"> | null,
  overrides: Partial<NativeDiagnosticPoint> = {},
): NativeDiagnosticPoint {
  return nativeDiagnosticPointSchema.parse({
    agentId: selection?.agentId ?? UNKNOWN_NATIVE_DIAGNOSTIC,
    profileMode: selection?.profileMode ?? UNKNOWN_NATIVE_DIAGNOSTIC,
    sourceVersion: selection?.sourceVersion ?? UNKNOWN_NATIVE_DIAGNOSTIC,
    sourceHash: selection?.sourceHash ?? UNKNOWN_NATIVE_DIAGNOSTIC,
    providerId: UNKNOWN_NATIVE_DIAGNOSTIC,
    model: UNKNOWN_NATIVE_DIAGNOSTIC,
    effort: UNKNOWN_NATIVE_DIAGNOSTIC,
    hostId: UNKNOWN_NATIVE_DIAGNOSTIC,
    environmentId: UNKNOWN_NATIVE_DIAGNOSTIC,
    path: UNKNOWN_NATIVE_DIAGNOSTIC,
    observationBoundary: UNKNOWN_NATIVE_DIAGNOSTIC,
    ...overrides,
  });
}

export function nativeDiagnostics(input: {
  requested?: Partial<NativeDiagnosticPoint>;
  resolved?: { selection: Pick<NativeSelection, "agentId" | "profileMode" | "sourceVersion" | "sourceHash"> | null; overrides?: Partial<NativeDiagnosticPoint> };
  target?: { selection: Pick<NativeSelection, "agentId" | "profileMode" | "sourceVersion" | "sourceHash"> | null; overrides?: Partial<NativeDiagnosticPoint> };
  effective?: { selection: Pick<NativeSelection, "agentId" | "profileMode" | "sourceVersion" | "sourceHash"> | null; overrides?: Partial<NativeDiagnosticPoint> };
  observed?: { selection: Pick<NativeSelection, "agentId" | "profileMode" | "sourceVersion" | "sourceHash"> | null; overrides?: Partial<NativeDiagnosticPoint> };
}): NativeDiagnostics {
  return nativeDiagnosticsSchema.parse({
    requested: nativeDiagnosticPoint(null, input.requested),
    resolved: nativeDiagnosticPoint(input.resolved?.selection ?? null, input.resolved?.overrides),
    target: nativeDiagnosticPoint(input.target?.selection ?? null, input.target?.overrides),
    effective: nativeDiagnosticPoint(input.effective?.selection ?? null, input.effective?.overrides),
    observed: nativeDiagnosticPoint(input.observed?.selection ?? null, input.observed?.overrides),
  });
}
