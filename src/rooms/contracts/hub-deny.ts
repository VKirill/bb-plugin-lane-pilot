/**
 * The hub and the machines behind it: the aliases and addresses every guard fences off for a Lane Pilot writer or helper.
 * The source of truth is `lane-stack/hooks/guard_shell.py` (`_HUB_NAMES`, `_HUB_ADDRESSES`); lane-stack's own guards run in
 * another runtime and cannot import this file, so tests/hub-deny.test.ts fails when any copy drifts.
 */
export const HUB_NAMES = ["ovh-main", "ovh-vps", "vechkasov-ovh", "selfystudio-work", "claude-dev-key", "rescue-vps"] as const;
/** The hub's WireGuard and public addresses, dotted. */
export const HUB_ADDRESSES = ["10.8.0.1", "54.37.129.153"] as const;
/** The same addresses as the 32-bit numbers `inet_aton` arithmetic yields (the shell guard compares numbers, not spellings). */
export const HUB_ADDRESS_INTS = [168296449, 908427673] as const;
