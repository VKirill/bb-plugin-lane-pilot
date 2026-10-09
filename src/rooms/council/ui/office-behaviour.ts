export type OfficeActivity = "speaking" | "arguing" | "waiting" | "idle";

export type OfficeActor = {
  id: string;
  label: string;
  color: string;
  activity: OfficeActivity;
  bubble?: string;
  facing?: string;
};

export type CouncilDetailLike = {
  id: string;
  state: string;
  speaking: string | null;
  speakingSince?: number | null;
  seats: Array<{ id: string; title: string }>;
  messages: Array<{ seq: number; seatId: string; round: number; kind: string; text: string; at?: number }>;
};

const SEAT_PALETTE = [
  "#3b82f6", // blue
  "#10b981", // emerald
  "#f59e0b", // amber
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#06b6d4", // cyan
  "#f97316", // orange
  "#84cc16", // lime
  "#14b8a6", // teal
  "#6366f1", // indigo
];

const TERMINAL_STATES = new Set(["done", "failed", "stopped"]);
const IDLE_TIMEOUT_MS = 20000;

export function seatColor(id: string): string {
  if (id === "owner") return "#e11d48"; // rose
  if (id === "chair") return "#64748b"; // slate
  if (id === "moderator") return "#71717a"; // zinc

  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return SEAT_PALETTE[hash % SEAT_PALETTE.length]!;
}

export function nextWanderTarget(rng: () => number, current: string | null, points: string[]): string {
  if (points.length === 0) return "";
  const candidates = current ? points.filter((p) => p !== current) : points;
  if (candidates.length === 0) return current ?? points[0]!;
  const idx = Math.floor(rng() * candidates.length);
  return candidates[Math.max(0, Math.min(candidates.length - 1, idx))]!;
}

function truncateBubble(text: string, max = 80): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

export function deriveOfficeActors(
  detail: CouncilDetailLike,
  cursor: number | null,
  now: number
): OfficeActor[] {
  const visibleMessages = cursor === null
    ? detail.messages
    : detail.messages.filter((m) => m.seq <= cursor);

  // Replay cursor mode
  if (cursor !== null) {
    const activeMsg = visibleMessages.find((m) => m.seq === cursor) ?? null;
    const activeSpeakerId = activeMsg?.seatId ?? null;

    // Previous speaker to face if active message is reply
    let previousSpeakerId: string | undefined;
    if (activeMsg && activeMsg.kind === "reply") {
      const activeIdx = visibleMessages.findIndex((m) => m.seq === cursor);
      for (let i = activeIdx - 1; i >= 0; i--) {
        const prev = visibleMessages[i]!;
        if (prev.seatId !== activeSpeakerId) {
          previousSpeakerId = prev.seatId;
          break;
        }
      }
    }

    const hasOwnerMsg = visibleMessages.some((m) => m.seatId === "owner");
    const actors: OfficeActor[] = [];

    // Chair
    actors.push({
      id: "chair",
      label: "Chair",
      color: seatColor("chair"),
      activity: "chair" === activeSpeakerId
        ? (activeMsg?.kind === "reply" ? "arguing" : "speaking")
        : (activeSpeakerId ? "waiting" : "idle"),
      ...(activeSpeakerId === "chair" && activeMsg ? { bubble: truncateBubble(activeMsg.text) } : {}),
      ...(activeSpeakerId === "chair" && activeMsg?.kind === "reply" && previousSpeakerId ? { facing: previousSpeakerId } : {}),
    });

    // Owner (only if spoke up to cursor)
    if (hasOwnerMsg) {
      actors.push({
        id: "owner",
        label: "Owner",
        color: seatColor("owner"),
        activity: "owner" === activeSpeakerId
          ? (activeMsg?.kind === "reply" ? "arguing" : "speaking")
          : (activeSpeakerId ? "waiting" : "idle"),
        ...(activeSpeakerId === "owner" && activeMsg ? { bubble: truncateBubble(activeMsg.text) } : {}),
        ...(activeSpeakerId === "owner" && activeMsg?.kind === "reply" && previousSpeakerId ? { facing: previousSpeakerId } : {}),
      });
    }

    // Regular seats
    for (const seat of detail.seats) {
      const isSpeaking = seat.id === activeSpeakerId;
      actors.push({
        id: seat.id,
        label: seat.title,
        color: seatColor(seat.id),
        activity: isSpeaking
          ? (activeMsg?.kind === "reply" ? "arguing" : "speaking")
          : (activeSpeakerId ? "waiting" : "idle"),
        ...(isSpeaking && activeMsg ? { bubble: truncateBubble(activeMsg.text) } : {}),
        ...(isSpeaking && activeMsg?.kind === "reply" && previousSpeakerId ? { facing: previousSpeakerId } : {}),
      });
    }

    return actors;
  }

  // Live mode
  const isTerminal = TERMINAL_STATES.has(detail.state);
  const liveSpeaker = detail.speaking;
  const isIdleTimeout = Boolean(
    !liveSpeaker &&
    detail.speakingSince &&
    now - detail.speakingSince > IDLE_TIMEOUT_MS
  );
  const isWandering = isTerminal || isIdleTimeout || (!liveSpeaker && !detail.speakingSince);

  const hasOwnerMsg = detail.messages.some((m) => m.seatId === "owner");
  const latestMsg = detail.messages.length > 0 ? detail.messages[detail.messages.length - 1] : null;

  // If live speaker is speaking, bubble is either their latest message start or «…»
  const getLiveBubble = (id: string): string => {
    // Find latest message by this speaker
    for (let i = detail.messages.length - 1; i >= 0; i--) {
      if (detail.messages[i]!.seatId === id) {
        return truncateBubble(detail.messages[i]!.text);
      }
    }
    return "…";
  };

  // Find previous speaker for reply facing
  let replyFacing: string | undefined;
  if (liveSpeaker && latestMsg && latestMsg.seatId === liveSpeaker && latestMsg.kind === "reply") {
    for (let i = detail.messages.length - 2; i >= 0; i--) {
      if (detail.messages[i]!.seatId !== liveSpeaker) {
        replyFacing = detail.messages[i]!.seatId;
        break;
      }
    }
  }

  const actors: OfficeActor[] = [];

  // Chair
  const chairIsSpeaking = liveSpeaker === "chair";
  actors.push({
    id: "chair",
    label: "Chair",
    color: seatColor("chair"),
    activity: chairIsSpeaking
      ? (latestMsg?.kind === "reply" && latestMsg.seatId === "chair" ? "arguing" : "speaking")
      : (isWandering ? "idle" : "waiting"),
    ...(chairIsSpeaking ? { bubble: getLiveBubble("chair") } : {}),
    ...(chairIsSpeaking && replyFacing ? { facing: replyFacing } : {}),
  });

  // Owner (only if owner sent a message)
  if (hasOwnerMsg) {
    const ownerIsSpeaking = liveSpeaker === "owner";
    actors.push({
      id: "owner",
      label: "Owner",
      color: seatColor("owner"),
      activity: ownerIsSpeaking
        ? (latestMsg?.kind === "reply" && latestMsg.seatId === "owner" ? "arguing" : "speaking")
        : (isWandering ? "idle" : "waiting"),
      ...(ownerIsSpeaking ? { bubble: getLiveBubble("owner") } : {}),
      ...(ownerIsSpeaking && replyFacing ? { facing: replyFacing } : {}),
    });
  }

  // Seats
  for (const seat of detail.seats) {
    const seatIsSpeaking = liveSpeaker === seat.id;
    actors.push({
      id: seat.id,
      label: seat.title,
      color: seatColor(seat.id),
      activity: seatIsSpeaking
        ? (latestMsg?.kind === "reply" && latestMsg.seatId === seat.id ? "arguing" : "speaking")
        : (isWandering ? "idle" : "waiting"),
      ...(seatIsSpeaking ? { bubble: getLiveBubble(seat.id) } : {}),
      ...(seatIsSpeaking && replyFacing ? { facing: replyFacing } : {}),
    });
  }

  return actors;
}
