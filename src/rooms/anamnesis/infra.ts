/**
 * Text that is about infrastructure and never about the owner as a person: addresses, ssh and key paths, secret files, hosts with a
 * port, environment variable names. Such a line comes from a work note (a Claude memory about the hub, a message with a command) and
 * is never stored as a fact about the owner, never sent to Jev and never written to the portrait. Pure, no node imports.
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/(?<![\d.])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?![\d.])/, "an IP address"],
  [/\b(?:ssh|scp|sftp|rsync)\s+(?:-\w+\s+\S+\s+)*(?:-i\b|\S+@\S+)/i, "an ssh command"],
  [/(?:^|\s)-i\s+\S*(?:\.ssh|id_(?:rsa|ed25519|ecdsa)|\.pem|\.key)\b/i, "an ssh key option"],
  [/(?:~|\$HOME|\/Users\/[^/\s]+|\/home\/[^/\s]+|\/root)\/(?:\.ssh|\.gnupg|\.aws|\.config|\.secrets?|secrets?)\b/i, "a key or secret path"],
  [/\b(?:id_(?:rsa|ed25519|ecdsa)|authorized_keys|known_hosts)\b|\.(?:pem|p12|pfx)\b|(?:^|[\s/])\.env(?:\.\w+)?\b|(?:^|\/)secrets?\/\S+/i, "a key or secret file"],
  [/\b(?:[a-z0-9-]+\.)+(?:pro|dev|io|app|cloud|net|local|internal|lan|ru|com|org):\d{2,5}\b/i, "a host with a port"],
  [/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d{2,5})?\b/i, "a local address"],
  [/\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/, "an environment variable name"],
  [/\b(?:wg-quick|wireguard|systemctl|launchctl|kubectl|iptables)\b/i, "a system command"],
];

/** Why a text is infrastructure, or null. */
export function infrastructureReason(...parts: Array<string | undefined | null>): string | null {
  const text = parts.filter(Boolean).join("\n");
  for (const [pattern, reason] of PATTERNS) if (pattern.test(text)) return reason;
  return null;
}
