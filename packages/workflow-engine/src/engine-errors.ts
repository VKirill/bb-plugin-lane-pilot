/** Thrown by the test hook; never treated as a step failure. */
export class CrashError extends Error {}

export class RouteFailure extends Error { constructor(readonly code: string, message: string) { super(message); } }
export const isEngineBug = (cause: unknown) => cause instanceof CrashError || (cause instanceof Error && /database connection is not open|closed/i.test(cause.message));
