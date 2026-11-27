// Public API of repo-trust: pure trust thresholds, level computation, and gating-rule mapping.
export {
  TRUST_HIGH_MAX_ROLLBACKS,
  TRUST_LOW_MIN_ROLLBACKS,
  TRUST_WINDOW_DAYS,
  TRUST_WINDOW_MS,
  buildTrustRules,
  computeTrustLevel,
  type TrustGateState,
  type TrustLevel,
  type TrustRule,
} from "./models/trust-level";
