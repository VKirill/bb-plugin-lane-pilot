/**
 * Which addresses a design pair may open. The pair verb starts a browser on the hub and sends the screenshot to a judge, so a URL an
 * agent names must not reach a file, a service on this machine or a private network. Pure: the host-name lookup happens in the caller
 * and arrives as `resolved`; the owner's `--local` is `local: true` and is never granted to an agent thread (the caller check does that).
 */
export type PairUrlOptions = {
  local?: boolean;
  /** The ports of the hub's own services (BB server, host daemon): refused on any host name that is this machine. */
  hubPorts?: readonly number[];
  /** The addresses the host name resolves to (a literal address resolves to itself). */
  resolved?: readonly string[];
  /** The addresses of this machine's interfaces. */
  ownAddresses?: readonly string[];
};

const v4Parts = (host: string): number[] | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
};

/** The class of an IPv4 address that a pair may not open, or null. */
function v4Class(p: readonly number[]): string | null {
  const [a, b] = p as [number, number];
  if (a === 0) return "an unspecified address";
  if (a === 127) return "a loopback address";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "a private network address";
  if (a === 169 && b === 254) return "a link-local address";
  return null;
}

/** An IPv6 address as eight 16-bit groups, or null when it is not one. */
function v6Groups(host: string): number[] | null {
  let text = host.toLowerCase().replace(/%.*$/, "");
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (tail) {
    const q = v4Parts(tail[1]!);
    if (!q) return null;
    text = text.slice(0, -tail[1]!.length) + ((q[0]! << 8) | q[1]!).toString(16) + ":" + ((q[2]! << 8) | q[3]!).toString(16);
  }
  if (!/^[0-9a-f:]+$/.test(text) || (text.match(/::/g) ?? []).length > 1) return null;
  const [head, rest] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = rest !== undefined && rest !== "" ? rest.split(":") : [];
  const fill = text.includes("::") ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array<string>(Math.max(fill, 0)).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((g) => g === "" || g.length > 4)) return null;
  return groups.map((g) => parseInt(g, 16));
}

/** The class of an IP literal (v4 or v6, any spelling the URL parser has already normalised) that a pair may not open, or null. */
export function addressClass(address: string): string | null {
  const host = address.replace(/^\[|\]$/g, "");
  const four = v4Parts(host);
  if (four) return v4Class(four);
  const g = v6Groups(host);
  if (!g) return null;
  if (g.every((x) => x === 0)) return "an unspecified address";
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "a loopback address";
  if ((g[0]! & 0xfe00) === 0xfc00) return "a private network address";
  if ((g[0]! & 0xffc0) === 0xfe80) return "a link-local address";
  // IPv4 carried inside IPv6: mapped (::ffff:a.b.c.d), compatible (::a.b.c.d) and NAT64 (64:ff9b::a.b.c.d).
  const embedded = [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255];
  const mapped = g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff;
  const compatible = g.slice(0, 6).every((x) => x === 0);
  const nat64 = g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0);
  return mapped || compatible || nat64 ? v4Class(embedded) : null;
}

/** Why a pair may not open this URL, or null. Every refusal says what was refused and why. */
export function pairUrlRefusal(raw: string, options: PairUrlOptions = {}): string | null {
  let url: URL;
  try { url = new URL(raw); } catch { return `refused: ${raw.slice(0, 80)} is not a URL`; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return `refused: ${url.protocol} URLs are not opened by a design pair, only http: and https:`;
  if (options.local) return null;
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (host === "" ) return `refused: ${raw.slice(0, 80)} has no host`;
  if (host === "localhost" || host.endsWith(".localhost")) return `refused: ${host} is this machine; the owner passes --local from a terminal for a local preview`;
  const own = addressClass(host);
  if (own) return `refused: ${host} is ${own}; the owner passes --local from a terminal for a local preview`;
  for (const address of options.resolved ?? []) {
    const klass = addressClass(address);
    if (klass) return `refused: ${host} resolves to ${address}, ${klass}; the owner passes --local from a terminal for a local preview`;
  }
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if ((options.hubPorts ?? []).includes(port)) {
    const mine = new Set((options.ownAddresses ?? []).map((a) => a.toLowerCase()));
    if ((options.resolved ?? []).some((a) => mine.has(a.toLowerCase()))) return `refused: ${host}:${port} is the hub's own port on this machine`;
  }
  return null;
}
