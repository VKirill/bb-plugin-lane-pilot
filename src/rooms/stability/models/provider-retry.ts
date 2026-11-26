export const PROVIDER_RETRY_CONSENT_METHOD = "provider-retry.v1.consent";

export type RetryEligibility =
  | { kind: "allow"; reason: string }
  | { kind: "decline"; reason: string }
  | { kind: "unknown" };
