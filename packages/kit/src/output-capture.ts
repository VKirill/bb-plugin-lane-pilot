/** The beginning and the end of a stream, with a note for what fell between: a command that fails says why at its end, and how it started at its beginning. */
export function createCapture(cap: number) {
  const headMax = Math.floor(cap / 4), tailMax = cap - headMax;
  let head = Buffer.alloc(0), tail = Buffer.alloc(0), dropped = 0;
  return {
    push(chunk: Buffer): void {
      let rest = chunk;
      if (head.length < headMax) {
        const take = Math.min(headMax - head.length, rest.length);
        head = Buffer.concat([head, rest.subarray(0, take)]);
        rest = rest.subarray(take);
      }
      if (!rest.length) return;
      tail = Buffer.concat([tail, rest]);
      if (tail.length > tailMax) { dropped += tail.length - tailMax; tail = tail.subarray(tail.length - tailMax); }
    },
    get truncated(): boolean { return dropped > 0; },
    text(): string { return dropped ? `${head.toString("utf8")}\n[... ${dropped} bytes cut ...]\n${tail.toString("utf8")}` : Buffer.concat([head, tail]).toString("utf8"); },
  };
}
