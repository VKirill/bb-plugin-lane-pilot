export * from "./office-layout";
export {
  isOfficeFloorBlocked as isFloorBlocked,
  isOfficeSegmentBlocked as isLineSegmentBlocked,
  findOfficeFloorPath as findOfficePath,
} from "./office-layout";

import { OFFICE_SPOTS, OWNER_SEAT_ID } from "./office-layout";

export type OfficeActivity = "speaking" | "arguing" | "waiting" | "idle";

export type OfficeActor = {
  id: string;
  label: string;
  color: string;
  activity: OfficeActivity;
  bubble?: string;
  facing?: string;
  /** Owner only, replay: the cursor is on the owner's message or on a reply to him within two messages. */
  holdAtMeeting?: boolean;
};

export type CouncilDetailLike = {
  id: string;
  state: string;
  speaking: string | null;
  speakingSince?: number | null;
  seats: Array<{ id: string; title: string }>;
  messages: Array<{ seq: number; seatId: string; round: number; kind: string; text: string; at?: number }>;
};

export type OfficePose = {
  sitting: boolean;
  bodyY: number;
  headY: number;
  leftArmPitch: number;
  rightArmPitch: number;
  leftArmYaw: number;
  rightArmYaw: number;
  leftArmRoll: number;
  rightArmRoll: number;
  leftLegPitch: number;
  rightLegPitch: number;
  headPitch: number;
  headYaw: number;
  pointing: boolean;
  action?: string;
  /** 0 standing … 1 fully seated (blends continuously with the sitting progress). */
  sitAmount: number;
  /** Elbow flexion in radians, 0 = straight arm, forearm swings forward. */
  leftElbow: number;
  rightElbow: number;
  /** Knee flexion of the standing/walking pose in radians (the seat adds its own bend). */
  leftKnee: number;
  rightKnee: number;
  /** Torso lean forward in radians and spine twist about the vertical axis. */
  torsoLean: number;
  spineYaw: number;
  /** 0..1: a mug in the right hand. */
  cup: number;
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

export function seatColor(id: string, seatsOrIndex?: Array<{ id: string }> | number): string {
  if (id === "owner") return "#e11d48"; // rose
  if (id === "chair") return "#64748b"; // slate
  if (id === "moderator") return "#71717a"; // zinc

  if (typeof seatsOrIndex === "number") {
    return SEAT_PALETTE[Math.abs(seatsOrIndex) % SEAT_PALETTE.length]!;
  }

  if (Array.isArray(seatsOrIndex)) {
    const regularSeats = seatsOrIndex.filter(
      (s) => s.id !== "owner" && s.id !== "chair" && s.id !== "moderator"
    );
    const idx = regularSeats.findIndex((s) => s.id === id);
    if (idx !== -1) {
      return SEAT_PALETTE[idx % SEAT_PALETTE.length]!;
    }
  }

  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return SEAT_PALETTE[hash % SEAT_PALETTE.length]!;
}

export function assignSeatColors(seats: Array<{ id: string }>): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of seats) {
    map.set(s.id, seatColor(s.id, seats));
  }
  return map;
}

export function stripMarkdown(text: string): string {
  return text
    // Fenced code blocks
    .replace(/```[\s\S]*?```/g, "")
    // Inline code
    .replace(/`([^`]+)`/g, "$1")
    // Images
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    // Links
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    // Headers
    .replace(/^#{1,6}\s+/gm, "")
    // Blockquotes
    .replace(/^>\s+/gm, "")
    // Bold / italic
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    // Strikethrough
    .replace(/~~(.*?)~~/g, "$1")
    // Bullet / numbered lists
    .replace(/^[\*\-+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    // Collapse whitespace
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatBubbleText(text: string, max = 80): string {
  const plain = stripMarkdown(text);
  if (plain.length <= max) return plain;
  return `${plain.slice(0, max - 1).trimEnd()}…`;
}

/** Projected floor bounds of slab and back walls at the reference camera (reference.md §4). */
export const OFFICE_FIT = { width: 44.4, height: 22.7, centerY: 1.3 };

/**
 * Orthographic view size for a canvas of the given aspect (width / height): contain the floor with 3 % padding.
 */
export function fitOfficeCamera(aspect: number): { viewWidth: number; viewHeight: number; centerY: number } {
  const safeAspect = Math.max(0.1, aspect);
  const viewHeight = Math.max(OFFICE_FIT.height, OFFICE_FIT.width / safeAspect) * 1.03;
  return { viewWidth: viewHeight * safeAspect, viewHeight, centerY: OFFICE_FIT.centerY };
}

export type ScreenLabel = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isSpeaker?: boolean;
};

export type ResolvedLabel = {
  id: string;
  x: number;
  y: number;
  collapsed: boolean;
};

/** Tags overlapping an earlier one by more than this share of the smaller box collapse to a dot. */
const LABEL_OVERLAP_LIMIT = 0.3;

export function resolveLabelCollisions(
  labels: ScreenLabel[],
  bounds?: { width: number; height: number }
): ResolvedLabel[] {
  const result: ResolvedLabel[] = labels.map((l) => ({
    id: l.id,
    x: l.x,
    y: l.y,
    collapsed: false,
  }));

  const calcOverlap = (
    l1: { x: number; y: number; width: number; height: number },
    l2: { x: number; y: number; width: number; height: number }
  ) => {
    const left = Math.max(l1.x - l1.width / 2, l2.x - l2.width / 2);
    const right = Math.min(l1.x + l1.width / 2, l2.x + l2.width / 2);
    const top = Math.max(l1.y - l1.height / 2, l2.y - l2.height / 2);
    const bottom = Math.min(l1.y + l1.height / 2, l2.y + l2.height / 2);
    if (right <= left || bottom <= top) return 0;
    const intersection = (right - left) * (bottom - top);
    const minArea = Math.min(l1.width * l1.height, l2.width * l2.height);
    return minArea > 0 ? intersection / minArea : 0;
  };

  // Pass 1: collapse crowded non-speakers
  for (let i = 0; i < result.length; i++) {
    for (let j = i + 1; j < result.length; j++) {
      const orig1 = labels[i]!;
      const orig2 = labels[j]!;
      const r1 = result[i]!;
      const r2 = result[j]!;

      const w1 = r1.collapsed ? 10 : orig1.width;
      const h1 = r1.collapsed ? 10 : orig1.height;
      const w2 = r2.collapsed ? 10 : orig2.width;
      const h2 = r2.collapsed ? 10 : orig2.height;

      const overlap = calcOverlap({ x: r1.x, y: r1.y, width: w1, height: h1 }, { x: r2.x, y: r2.y, width: w2, height: h2 });
      if (overlap > LABEL_OVERLAP_LIMIT) {
        if (!orig1.isSpeaker) r1.collapsed = true;
        if (!orig2.isSpeaker) r2.collapsed = true;
      }
    }
  }

  // Pass 2: separate any remaining overlaps
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < result.length; i++) {
      for (let j = i + 1; j < result.length; j++) {
        const orig1 = labels[i]!;
        const orig2 = labels[j]!;
        const r1 = result[i]!;
        const r2 = result[j]!;

        const w1 = r1.collapsed ? 10 : orig1.width;
        const h1 = r1.collapsed ? 10 : orig1.height;
        const w2 = r2.collapsed ? 10 : orig2.width;
        const h2 = r2.collapsed ? 10 : orig2.height;

        const overlap = calcOverlap({ x: r1.x, y: r1.y, width: w1, height: h1 }, { x: r2.x, y: r2.y, width: w2, height: h2 });
        if (overlap > LABEL_OVERLAP_LIMIT) {
          const dy = r2.y - r1.y;
          const shift = Math.max(2, ((h1 + h2) / 2 - Math.abs(dy)) / 2 + 2);
          if (orig1.isSpeaker) {
            r2.y += dy >= 0 ? shift * 2 : -shift * 2;
          } else if (orig2.isSpeaker) {
            r1.y += dy >= 0 ? -shift * 2 : shift * 2;
          } else {
            r1.y -= shift;
            r2.y += shift;
          }
        }
      }
    }
  }

  if (bounds) {
    for (let i = 0; i < result.length; i++) {
      const r = result[i]!;
      const orig = labels[i]!;
      const w = r.collapsed ? 10 : orig.width;
      const h = r.collapsed ? 10 : orig.height;
      r.x = Math.max(w / 2 + 4, Math.min(bounds.width - w / 2 - 4, r.x));
      r.y = Math.max(h / 2 + 4, Math.min(bounds.height - h / 2 - 4, r.y));
    }
  }

  return result;
}

/**
 * Moves one step towards a target at bounded speed, never teleporting.
 */
export function walkStep(
  current: { x: number; z: number },
  target: { x: number; z: number },
  speedOrMaxDist: number,
  dt?: number
): { x: number; z: number; reached: boolean; heading: number } {
  const maxStep = dt !== undefined ? speedOrMaxDist * dt : speedOrMaxDist;
  const dx = target.x - current.x;
  const dz = target.z - current.z;
  const dist = Math.hypot(dx, dz);
  const heading = dist > 1e-5 ? Math.atan2(dx, dz) : 0;

  if (dist <= maxStep || dist < 1e-5) {
    return {
      x: target.x,
      z: target.z,
      reached: true,
      heading,
    };
  }

  const ratio = maxStep / dist;
  return {
    x: current.x + dx * ratio,
    z: current.z + dz * ratio,
    reached: false,
    heading,
  };
}

/**
 * Selects an idle spot for an actor, ensuring two actors never share a spot.
 */
export function chooseIdleSpot(
  occupiedSpots: Set<string>,
  rng: () => number,
  currentSpot?: string | null
): string | null {
  const allSpotKeys = Object.keys(OFFICE_SPOTS);
  const available = allSpotKeys.filter(
    (key) => !occupiedSpots.has(key) && key !== currentSpot
  );

  if (available.length === 0) {
    const unoccupied = allSpotKeys.filter((key) => !occupiedSpots.has(key));
    if (unoccupied.length === 0) return null;
    const idx = Math.floor(rng() * unoccupied.length);
    return unoccupied[idx] ?? null;
  }

  const idx = Math.floor(rng() * available.length);
  return available[idx] ?? null;
}

/** 0..1 hump that is zero most of the time: a hand going up to a shelf now and then. */
function smoothReach(tick: number): number {
  const wave = Math.sin(tick * 0.8);
  const x = Math.max(0, (wave - 0.35) / 0.65);
  return x * x * (3 - 2 * x);
}

/**
 * Calculates joint angles and body positioning for an actor's current activity.
 */
export function getOfficePose(
  activity: OfficeActivity,
  options?: {
    tick?: number;
    isWalking?: boolean;
    sittingProgress?: number;
    action?: string;
  }
): OfficePose {
  const tick = options?.tick ?? 0;
  const isWalking = options?.isWalking ?? false;
  const sittingProgress = isWalking
    ? 0
    : (options?.sittingProgress ?? (activity === "waiting" ? 1 : 0));
  const action = options?.action;

  // Base standing pose values
  let bodyY = 0.88;
  let headY = 1.35;
  let leftArmPitch = 0;
  let rightArmPitch = 0;
  let leftArmYaw = 0;
  let rightArmYaw = 0;
  let leftArmRoll = 0;
  let rightArmRoll = 0;
  let leftLegPitch = 0;
  let rightLegPitch = 0;
  let headPitch = 0;
  let headYaw = 0;
  let pointing = false;
  let leftElbow = 0.15;
  let rightElbow = 0.15;
  let leftKnee = 0;
  let rightKnee = 0;
  let torsoLean = 0;
  let spineYaw = 0;
  let cup = 0;

  if (isWalking) {
    const legSwing = Math.sin(tick * 8) * 0.55;
    leftLegPitch = legSwing;
    rightLegPitch = -legSwing;
    leftArmPitch = -legSwing * 0.6;
    rightArmPitch = legSwing * 0.6;
    bodyY = 0.88 + Math.abs(Math.sin(tick * 8)) * 0.04;
    headY = 1.35 + Math.abs(Math.sin(tick * 8)) * 0.04;
    // the knee folds while its leg swings forward and the arm opposite to a leg bends as it comes forward
    const phase = Math.cos(tick * 8);
    leftKnee = 0.12 + 0.95 * Math.max(0, -phase);
    rightKnee = 0.12 + 0.95 * Math.max(0, phase);
    leftElbow = 0.35 + 0.35 * Math.max(0, Math.sin(tick * 8));
    rightElbow = 0.35 + 0.35 * Math.max(0, -Math.sin(tick * 8));
    torsoLean = 0.07;
    spineYaw = Math.sin(tick * 8) * 0.12;
    headPitch = -0.04;
  } else if (activity === "speaking") {
    const gesture1 = Math.sin(tick * 4) * 0.35;
    const gesture2 = Math.cos(tick * 3) * 0.25;
    leftArmPitch = -0.5 + gesture1;
    rightArmPitch = 0.2 + gesture2;
    leftArmRoll = 0.2;
    rightArmRoll = -0.2;
    headPitch = Math.sin(tick * 4) * 0.08;
    bodyY = 0.88 + Math.sin(tick * 4) * 0.02;
    headY = 1.35 + Math.sin(tick * 4) * 0.03;
    leftElbow = 1.0 + Math.sin(tick * 4 + 1) * 0.4;
    rightElbow = 0.7 + Math.cos(tick * 3) * 0.35;
    spineYaw = Math.sin(tick * 1.3) * 0.08;
    torsoLean = 0.03;
  } else if (activity === "arguing") {
    pointing = true;
    rightArmPitch = -Math.PI / 2 + Math.sin(tick * 3) * 0.08;
    rightArmRoll = -0.1;
    leftArmPitch = 0.35 + Math.sin(tick * 4) * 0.2;
    headPitch = Math.sin(tick * 5) * 0.1;
    bodyY = 0.88;
    headY = 1.35;
    rightElbow = 0.06;
    leftElbow = 1.25 + Math.sin(tick * 4) * 0.25;
    leftArmRoll = 0.35;
    torsoLean = 0.1;
    spineYaw = 0.1;
  } else if (activity === "waiting") {
    headPitch = Math.sin(tick * 1.5) * 0.03;
    // seated at the table: forearms resting forward on it, hands loosely together
    leftArmPitch = -0.55;
    rightArmPitch = -0.55;
    leftElbow = 1.05 + Math.sin(tick * 0.9) * 0.04;
    rightElbow = 1.05 + Math.cos(tick * 0.8) * 0.04;
    leftArmRoll = 0.12;
    rightArmRoll = -0.12;
    torsoLean = 0.1;
  } else if (activity === "idle") {
    if (action === "typing") {
      // sitting, upper arms a little forward, forearms level to the keyboard, fingers moving
      leftArmPitch = -0.5;
      rightArmPitch = -0.5;
      leftElbow = 1.32 + Math.sin(tick * 10) * 0.07;
      rightElbow = 1.32 - Math.sin(tick * 10 + 0.8) * 0.07;
      leftArmRoll = 0.1;
      rightArmRoll = -0.1;
      headPitch = 0.14 + Math.sin(tick * 0.5) * 0.03;
      torsoLean = 0.14;
    } else if (action === "coffee" || action === "bar") {
      // the mug rests at chest height and goes up to the mouth now and then
      const sip = Math.pow(Math.max(0, Math.sin(tick * 0.9)), 2);
      rightArmPitch = -0.35 - sip * 0.5;
      rightElbow = 1.0 + sip * 0.85;
      rightArmYaw = 0.2;
      rightArmRoll = -0.1;
      leftArmPitch = 0.05;
      leftElbow = 0.35;
      headPitch = -sip * 0.14;
      torsoLean = 0.02;
      cup = 1;
    } else if (action === "chat") {
      // Talking with someone: hands move, the head nods
      leftArmPitch = -0.35 + Math.sin(tick * 3.1) * 0.3;
      rightArmPitch = 0.1 + Math.cos(tick * 2.3) * 0.25;
      leftArmRoll = 0.15;
      headPitch = Math.sin(tick * 2.2) * 0.08;
      headYaw = Math.sin(tick * 0.7) * 0.15;
      leftElbow = 1.1 + Math.sin(tick * 3.1 + 1) * 0.35;
      rightElbow = 0.9 + Math.cos(tick * 2.3) * 0.3;
      spineYaw = Math.sin(tick * 0.7) * 0.06;
      leftKnee = 0.05;
      rightKnee = 0.14;
    } else if (action === "operate") {
      // Working a machine or a shelf standing: both forearms forward at waist height, one hand reaching up now and then
      const reach = smoothReach(tick);
      leftArmPitch = -0.35 + Math.sin(tick * 5) * 0.03;
      leftElbow = 1.2;
      rightArmPitch = -0.35 - reach * 0.85;
      rightElbow = 1.2 - reach * 0.6;
      headPitch = 0.12 - reach * 0.12;
      torsoLean = 0.08 + reach * 0.04;
    } else if (action === "window") {
      // looking out, hands relaxed and loosely together in front
      leftArmPitch = -0.1;
      rightArmPitch = -0.1;
      leftArmYaw = 0.0;
      rightArmYaw = 0.0;
      leftElbow = 0.55;
      rightElbow = 0.55;
      leftArmRoll = 0.2;
      rightArmRoll = -0.2;
      headPitch = -0.04 + Math.sin(tick * 0.4) * 0.02;
      headYaw = Math.sin(tick * 0.25) * 0.12;
    } else {
      leftArmPitch = Math.sin(tick * 2) * 0.08;
      rightArmPitch = -Math.sin(tick * 2) * 0.08;
      leftElbow = 0.2;
      rightElbow = 0.2;
    }
  }

  if (sittingProgress > 0) {
    const sitRatio = Math.max(0, Math.min(1, sittingProgress));
    bodyY = bodyY * (1 - sitRatio) + 0.70 * sitRatio;
    headY = headY * (1 - sitRatio) + 1.20 * sitRatio;
    leftLegPitch = leftLegPitch * (1 - sitRatio) + (Math.PI / 2) * sitRatio;
    rightLegPitch = rightLegPitch * (1 - sitRatio) + (Math.PI / 2) * sitRatio;
    // seated at a sofa or a stool: forearms resting on the thighs (a mug stays in the right hand)
    if (activity === "idle" && action !== "typing") {
      const holdsCup = action === "coffee" || action === "bar";
      leftArmPitch = leftArmPitch * (1 - sitRatio) - 0.3 * sitRatio;
      leftElbow = leftElbow * (1 - sitRatio) + 0.9 * sitRatio;
      if (!holdsCup) {
        rightArmPitch = rightArmPitch * (1 - sitRatio) - 0.3 * sitRatio;
        rightElbow = rightElbow * (1 - sitRatio) + 0.9 * sitRatio;
      }
      torsoLean = torsoLean * (1 - sitRatio) + 0.05 * sitRatio;
    }
  }

  return {
    sitting: sittingProgress > 0.5,
    sitAmount: Math.max(0, Math.min(1, sittingProgress)),
    leftElbow,
    rightElbow,
    leftKnee,
    rightKnee,
    torsoLean,
    spineYaw,
    cup,
    bodyY,
    headY,
    leftArmPitch,
    rightArmPitch,
    leftArmYaw,
    rightArmYaw,
    leftArmRoll,
    rightArmRoll,
    leftLegPitch,
    rightLegPitch,
    headPitch,
    headYaw,
    pointing,
    action,
  };
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

/** Replay: the owner holds at the meeting table while his message is current or a reply to him is within two messages. */
function ownerHoldsMeeting(detail: CouncilDetailLike, cursor: number, activeSpeakerId: string | null): boolean {
  if (activeSpeakerId === OWNER_SEAT_ID) return true;
  const idx = detail.messages.findIndex((m) => m.seq === cursor);
  if (idx < 0) return false;
  for (let j = idx; j <= Math.min(detail.messages.length - 1, idx + 2); j++) {
    const message = detail.messages[j]!;
    const previous = detail.messages[j - 1];
    if (message.kind === "reply" && previous?.seatId === OWNER_SEAT_ID) return true;
  }
  return false;
}

export function deriveOfficeActors(
  detail: CouncilDetailLike,
  cursor: number | null,
  now: number,
  options?: { pausedSince?: number | null; cursorSelectedAt?: number | null }
): OfficeActor[] {
  const visibleMessages = cursor === null
    ? detail.messages
    : detail.messages.filter((m) => m.seq <= cursor);

  // Replay cursor mode
  if (cursor !== null) {
    const activeMsg = visibleMessages.find((m) => m.seq === cursor) ?? null;
    const activeSpeakerId = activeMsg?.seatId ?? null;

    const isReplayIdle = Boolean(
      (options?.pausedSince && now - options.pausedSince > IDLE_TIMEOUT_MS) ||
      (options?.cursorSelectedAt && now - options.cursorSelectedAt > IDLE_TIMEOUT_MS)
    );
    const nonSpeakerActivity = (activeSpeakerId && !isReplayIdle) ? "waiting" : "idle";

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

    const actors: OfficeActor[] = [];

    // Chair
    actors.push({
      id: "chair",
      label: "Chair",
      color: seatColor("chair", detail.seats),
      activity: "chair" === activeSpeakerId
        ? (activeMsg?.kind === "reply" ? "arguing" : "speaking")
        : nonSpeakerActivity,
      ...(activeSpeakerId === "chair" && activeMsg ? { bubble: formatBubbleText(activeMsg.text) } : {}),
      ...(activeSpeakerId === "chair" && activeMsg?.kind === "reply" && previousSpeakerId ? { facing: previousSpeakerId } : {}),
    });

    // Owner: always on the floor; he speaks only under the cursor on his own message
    actors.push({
      id: OWNER_SEAT_ID,
      label: "Owner",
      color: seatColor(OWNER_SEAT_ID, detail.seats),
      activity: OWNER_SEAT_ID === activeSpeakerId
        ? (activeMsg?.kind === "reply" ? "arguing" : "speaking")
        : "idle",
      holdAtMeeting: ownerHoldsMeeting(detail, cursor, activeSpeakerId),
      ...(activeSpeakerId === OWNER_SEAT_ID && activeMsg ? { bubble: formatBubbleText(activeMsg.text) } : {}),
      ...(activeSpeakerId === OWNER_SEAT_ID && activeMsg?.kind === "reply" && previousSpeakerId ? { facing: previousSpeakerId } : {}),
    });

    // Regular seats
    for (const seat of detail.seats) {
      const isSpeaking = seat.id === activeSpeakerId;
      actors.push({
        id: seat.id,
        label: seat.title,
        color: seatColor(seat.id, detail.seats),
        activity: isSpeaking
          ? (activeMsg?.kind === "reply" ? "arguing" : "speaking")
          : nonSpeakerActivity,
        ...(isSpeaking && activeMsg ? { bubble: formatBubbleText(activeMsg.text) } : {}),
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

  const latestMsg = detail.messages.length > 0 ? detail.messages[detail.messages.length - 1] : null;

  const getLiveBubble = (id: string): string => {
    for (let i = detail.messages.length - 1; i >= 0; i--) {
      if (detail.messages[i]!.seatId === id) {
        return formatBubbleText(detail.messages[i]!.text);
      }
    }
    return "…";
  };

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
    color: seatColor("chair", detail.seats),
    activity: chairIsSpeaking
      ? (latestMsg?.kind === "reply" && latestMsg.seatId === "chair" ? "arguing" : "speaking")
      : (isWandering ? "idle" : "waiting"),
    ...(chairIsSpeaking ? { bubble: getLiveBubble("chair") } : {}),
    ...(chairIsSpeaking && replyFacing ? { facing: replyFacing } : {}),
  });

  // Owner: always on the floor
  const ownerIsSpeaking = liveSpeaker === OWNER_SEAT_ID;
  actors.push({
    id: OWNER_SEAT_ID,
    label: "Owner",
    color: seatColor(OWNER_SEAT_ID, detail.seats),
    activity: ownerIsSpeaking
      ? (latestMsg?.kind === "reply" && latestMsg.seatId === OWNER_SEAT_ID ? "arguing" : "speaking")
      : "idle",
    ...(ownerIsSpeaking ? { bubble: getLiveBubble(OWNER_SEAT_ID) } : {}),
    ...(ownerIsSpeaking && replyFacing ? { facing: replyFacing } : {}),
  });

  // Seats
  for (const seat of detail.seats) {
    const seatIsSpeaking = liveSpeaker === seat.id;
    actors.push({
      id: seat.id,
      label: seat.title,
      color: seatColor(seat.id, detail.seats),
      activity: seatIsSpeaking
        ? (latestMsg?.kind === "reply" && latestMsg.seatId === seat.id ? "arguing" : "speaking")
        : (isWandering ? "idle" : "waiting"),
      ...(seatIsSpeaking ? { bubble: getLiveBubble(seat.id) } : {}),
      ...(seatIsSpeaking && replyFacing ? { facing: replyFacing } : {}),
    });
  }

  return actors;
}
