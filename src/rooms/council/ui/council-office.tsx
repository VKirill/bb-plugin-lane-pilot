import { useEffect, useRef, useState } from "react";
import { t } from "@lane-pilot/i18n";
import { buildOfficeFloor } from "./office-scene";
import {
  OFFICE_SEATS,
  OWNER_SEAT_ID,
  assignOfficeSeats,
  createOfficeAgents,
  deriveOfficeActors,
  findOfficePath,
  fitOfficeCamera,
  formatBubbleText,
  getInteractionPoint,
  getOfficePose,
  resolveLabelCollisions,
  stepOfficeSimulation,
  walkStep,
  type CouncilDetailLike,
  type OfficeActor,
  type OfficeSeat,
  type OfficeSimAgent,
} from "./office-behaviour";

export type CouncilOfficeProps = {
  detail: CouncilDetailLike;
  cursor: number | null;
  highlightSeatId?: string | null;
  onSelectSpeaker?: (seatId: string) => void;
};

const TERMINAL_STATES = new Set(["done", "failed", "stopped"]);
/** The owner stays at the meeting table this long after his last live message (reference.md §5). */
const OWNER_HOLD_MS = 15000;
const WALK_SPEED = 2.0;
/** The owner hurries to the table; other people walk at WALK_SPEED. */
const OWNER_WALK_SPEED = 3.5;
/** Characters are 1.15 tiles tall: the chibi rig is built at 1.6 and scaled down. */
const RIG_SCALE = 0.72;
const LABEL_HEIGHT = 16;
const LABEL_CHAR_WIDTH = 6.2;
const LABEL_MAX_CHARS = 10;
const SKIN_PALETTE = ["#f2c39b", "#c68a5e", "#8d5a3a"];
const HAIR_PALETTE = ["#3a2a22", "#f0c060", "#6b3a1f"];
const PANTS_COLOR = 0x3a3d4a;
const SHOE_COLOR = 0x282a36;
const OUTLINE_COLOR = 0x282a36;

function checkWebGLSupport(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    return Boolean(
      (window as unknown as { WebGLRenderingContext?: unknown }).WebGLRenderingContext &&
      (canvas.getContext("webgl") || canvas.getContext("experimental-webgl"))
    );
  } catch {
    return false;
  }
}

function hashString(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/** Action for the walking pose, from the interaction point the character stands on. */
function actionForPoint(pointKind: string | undefined, pose: string | undefined): string | undefined {
  if (pose === "typing") return "typing";
  if (pose === "window_gaze") return "window";
  if (pose === "drinking") return pointKind === "bar" ? "bar" : "coffee";
  return undefined;
}

type Rig = {
  group: import("three").Group;
  body: import("three").Mesh;
  headGroup: import("three").Group;
  leftEye: import("three").Mesh;
  rightEye: import("three").Mesh;
  leftArmPivot: import("three").Group;
  rightArmPivot: import("three").Group;
  leftLegPivot: import("three").Group;
  rightLegPivot: import("three").Group;
  pos: { x: number; z: number };
  target: { x: number; z: number };
  path: Array<{ x: number; z: number }>;
  yaw: number;
  targetYaw: number;
  walking: boolean;
  blockedSeconds: number;
  walkTick: number;
  sitProgress: number;
  targetSit: boolean;
  action?: string;
  phase: number;
};

export function CouncilOffice({
  detail,
  cursor,
  highlightSeatId,
  onSelectSpeaker,
}: CouncilOfficeProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [hasWebGL, setHasWebGL] = useState<boolean>(() => checkWebGLSupport());
  const [actors, setActors] = useState<OfficeActor[]>(() =>
    deriveOfficeActors(detail, cursor, Date.now())
  );
  const [reactionGlyphs, setReactionGlyphs] = useState<Record<string, string>>({});

  // Mutable refs so the animation loop never closes over stale props and the scene is not recreated
  const detailRef = useRef(detail);
  const cursorRef = useRef(cursor);
  detailRef.current = detail;
  cursorRef.current = cursor;

  const lastCursorRef = useRef<number | null>(cursor);
  const cursorSelectedTimeRef = useRef<number>(Date.now());
  /** Set when the replay cursor jumps; the walkers then snap to their targets instead of walking. */
  const snapRef = useRef(false);
  const ownerHoldUntilRef = useRef(0);

  // DOM node references for projected HTML overlays (updated directly via ref transforms)
  const overlayMapRef = useRef(new Map<string, HTMLDivElement>());

  // Sync actors for React content (text, bubbles, highlight)
  useEffect(() => {
    const syncActors = () => {
      const now = Date.now();
      if (cursorRef.current !== lastCursorRef.current) {
        const previous = lastCursorRef.current;
        const next = cursorRef.current;
        const messages = detailRef.current.messages;
        const previousIdx = previous === null ? -1 : messages.findIndex((m) => m.seq === previous);
        const nextIdx = next === null ? -1 : messages.findIndex((m) => m.seq === next);
        // A jump is any cursor move that is not one message forward (⏭, clicks, reset)
        if (previous !== null && (next === null || nextIdx !== previousIdx + 1)) snapRef.current = true;
        lastCursorRef.current = next;
        cursorSelectedTimeRef.current = now;
      }
      setActors(
        deriveOfficeActors(detailRef.current, cursorRef.current, now, {
          cursorSelectedAt: cursorSelectedTimeRef.current,
        })
      );
    };
    syncActors();
    const timer = setInterval(syncActors, 1000);
    return () => clearInterval(timer);
  }, [detail, cursor]);

  useEffect(() => {
    if (!hasWebGL) return;

    let disposed = false;
    let animId: number | null = null;
    let resizeObserver: ResizeObserver | null = null;

    async function initThree() {
      let THREE: typeof import("three");
      try {
        THREE = await import("three");
      } catch {
        setHasWebGL(false);
        return;
      }

      if (disposed || !canvasRef.current || !containerRef.current) return;

      const container = containerRef.current;
      const canvas = canvasRef.current;

      let renderer: import("three").WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({
          canvas,
          antialias: false,
          alpha: false,
          powerPreference: "low-power",
        });
      } catch {
        setHasWebGL(false);
        return;
      }
      // One render pixel per two CSS pixels: the pixel-art look (reference.md §4)
      renderer.setPixelRatio(0.5);

      const scene = new THREE.Scene();
      const disposables: Array<{ dispose: () => void }> = [];

      // Camera: orthographic, azimuth 33°, elevation 30°, target = floor centre
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 500);
      camera.position.set(28.3, 30.0, 43.6);
      camera.lookAt(0, 0, 0);

      buildOfficeFloor({ THREE, scene, disposables });

      const outlineMat = new THREE.LineBasicMaterial({ color: OUTLINE_COLOR });
      disposables.push(outlineMat);

      const createMat = (color: number | string) => {
        const mat = new THREE.MeshLambertMaterial({ color });
        disposables.push(mat);
        return mat;
      };
      const createCharBox = (w: number, h: number, d: number, mat: import("three").Material) => {
        const geom = new THREE.BoxGeometry(w, h, d);
        disposables.push(geom);
        const mesh = new THREE.Mesh(geom, mat);
        const edges = new THREE.EdgesGeometry(geom, 30);
        disposables.push(edges);
        mesh.add(new THREE.LineSegments(edges, outlineMat));
        return mesh;
      };

      const charRigs = new Map<string, Rig>();
      const pantsMat = createMat(PANTS_COLOR);
      const shoeMat = createMat(SHOE_COLOR);
      const eyeMat = createMat(0x09090b);

      const buildRig = (actor: OfficeActor, seat: OfficeSeat, index: number): Rig => {
        const group = new THREE.Group();
        group.scale.setScalar(RIG_SCALE);
        const shirtMat = createMat(actor.color);
        const skinMat = createMat(SKIN_PALETTE[index % SKIN_PALETTE.length]!);
        const hairMat = createMat(actor.id === OWNER_SEAT_ID ? "#18181b" : HAIR_PALETTE[hashString(actor.id) % HAIR_PALETTE.length]!);

        const headGroup = new THREE.Group();
        headGroup.position.y = 1.35;
        headGroup.add(createCharBox(0.42, 0.42, 0.42, skinMat));
        const leftEye = createCharBox(0.06, 0.08, 0.04, eyeMat);
        leftEye.position.set(-0.1, 0.02, 0.22);
        headGroup.add(leftEye);
        const rightEye = createCharBox(0.06, 0.08, 0.04, eyeMat);
        rightEye.position.set(0.1, 0.02, 0.22);
        headGroup.add(rightEye);
        const hairTop = createCharBox(0.44, 0.16, 0.44, hairMat);
        hairTop.position.set(0, 0.16, -0.02);
        headGroup.add(hairTop);
        group.add(headGroup);

        const body = createCharBox(0.5, 0.55, 0.32, shirtMat);
        body.position.y = 0.88;
        group.add(body);

        const createArmPivot = (isLeft: boolean) => {
          const pivot = new THREE.Group();
          pivot.position.set(isLeft ? -0.32 : 0.32, 1.1, 0);
          const sleeve = createCharBox(0.14, 0.28, 0.14, shirtMat);
          sleeve.position.set(0, -0.14, 0);
          pivot.add(sleeve);
          const hand = createCharBox(0.12, 0.14, 0.12, skinMat);
          hand.position.set(0, -0.32, 0);
          pivot.add(hand);
          return pivot;
        };
        const leftArmPivot = createArmPivot(true);
        const rightArmPivot = createArmPivot(false);
        group.add(leftArmPivot, rightArmPivot);

        const createLegPivot = (isLeft: boolean) => {
          const pivot = new THREE.Group();
          pivot.position.set(isLeft ? -0.14 : 0.14, 0.55, 0);
          const pants = createCharBox(0.16, 0.45, 0.18, pantsMat);
          pants.position.set(0, -0.22, 0);
          pivot.add(pants);
          const shoe = createCharBox(0.18, 0.12, 0.24, shoeMat);
          shoe.position.set(0, -0.48, 0.03);
          pivot.add(shoe);
          return pivot;
        };
        const leftLegPivot = createLegPivot(true);
        const rightLegPivot = createLegPivot(false);
        group.add(leftLegPivot, rightLegPivot);

        group.position.set(seat.x, 0, seat.z);
        group.rotation.y = seat.angle;
        scene.add(group);

        return {
          group,
          body,
          headGroup,
          leftEye,
          rightEye,
          leftArmPivot,
          rightArmPivot,
          leftLegPivot,
          rightLegPivot,
          pos: { x: seat.x, z: seat.z },
          target: { x: seat.x, z: seat.z },
          path: [],
          yaw: seat.angle,
          targetYaw: seat.angle,
          walking: false,
          blockedSeconds: 0,
          walkTick: index * 1.5,
          sitProgress: 1,
          targetSit: true,
          phase: index * 1.7,
        };
      };

      const getOrAddRig = (actor: OfficeActor, seat: OfficeSeat, index: number): Rig => {
        let rig = charRigs.get(actor.id);
        if (!rig) {
          rig = buildRig(actor, seat, index);
          charRigs.set(actor.id, rig);
        }
        return rig;
      };

      // Behaviour: the same simulation the tests check, re-created when the set of actors changes
      let simAgents: OfficeSimAgent[] = [];
      let simIds = "";
      const reservations = new Map<string, string>();

      const handleResize = () => {
        const w = container.clientWidth || 320;
        const h = container.clientHeight || 240;
        renderer.setSize(w, h, false);
        const { viewWidth, viewHeight, centerY } = fitOfficeCamera(w / h);
        camera.left = -viewWidth / 2;
        camera.right = viewWidth / 2;
        camera.top = viewHeight / 2 + centerY;
        camera.bottom = -viewHeight / 2 + centerY;
        camera.updateProjectionMatrix();
      };

      resizeObserver = new ResizeObserver(handleResize);
      resizeObserver.observe(container);
      handleResize();

      const motionReduced =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      let lastTime = performance.now();
      let lastReactionCheck = Date.now();

      const animate = (nowTime: number) => {
        if (disposed) return;
        const dt = Math.min(0.1, Math.max(0.001, (nowTime - lastTime) / 1000));
        lastTime = nowTime;
        const nowMs = Date.now();
        const timeSec = nowTime / 1000;

        const currentDetail = detailRef.current;
        const currentCursor = cursorRef.current;
        const currentActors = deriveOfficeActors(currentDetail, currentCursor, nowMs);
        const seatAssignments = assignOfficeSeats(currentActors);

        const ownerActor = currentActors.find((a) => a.id === OWNER_SEAT_ID);
        const isTerminal = TERMINAL_STATES.has(currentDetail.state);
        const ownerSpeaking = ownerActor?.activity === "speaking" || ownerActor?.activity === "arguing";
        if (ownerSpeaking && currentCursor === null && !isTerminal) ownerHoldUntilRef.current = nowMs + OWNER_HOLD_MS;
        if (isTerminal) ownerHoldUntilRef.current = 0;
        // Replay: the table while the cursor holds him. Live: while speaking, then 15 s more.
        const ownerWantsMeeting = currentCursor !== null
          ? Boolean(ownerActor?.holdAtMeeting)
          : !isTerminal && (ownerSpeaking || nowMs < ownerHoldUntilRef.current);

        const councilLive = currentActors.some((a) =>
          a.id !== OWNER_SEAT_ID && (a.activity === "waiting" || a.activity === "speaking" || a.activity === "arguing")
        );

        // Sim agents follow the actor list (the same order as the seat assignment above)
        const ids = currentActors.map((a) => a.id).join("|");
        if (ids !== simIds) {
          simIds = ids;
          simAgents = createOfficeAgents(currentActors.map((a) => a.id));
          reservations.clear();
        }
        // The owner pulls report visitors away from the corridor the moment he walks to the table
        if (ownerWantsMeeting) {
          for (const agent of simAgents) if (agent.activity === "report") agent.stateDuration = 0;
        }
        stepOfficeSimulation(simAgents, reservations, nowMs / 1000, dt, Math.random, councilLive);
        const simById = new Map(simAgents.map((agent) => [agent.id, agent] as const));

        const activeSpeaker = currentActors.find((a) => a.activity === "speaking" || a.activity === "arguing");

        // Periodic listener reaction bubble (!, ?, …, хм)
        if (activeSpeaker && nowMs - lastReactionCheck > 4500) {
          lastReactionCheck = nowMs;
          const listeners = currentActors.filter(
            (a) => a.id !== activeSpeaker.id && a.activity === "waiting"
          );
          if (listeners.length > 0 && Math.random() < 0.6) {
            const listener = listeners[Math.floor(Math.random() * listeners.length)]!;
            const glyphs = ["!", "?", "…", "хм"];
            const glyph = glyphs[Math.floor(Math.random() * glyphs.length)]!;
            setReactionGlyphs({ [listener.id]: glyph });
            setTimeout(() => {
              if (!disposed) setReactionGlyphs({});
            }, 2400);
          }
        }

        const snap = snapRef.current;
        currentActors.forEach((actor, idx) => {
          const seat = seatAssignments.get(actor.id) ?? OFFICE_SEATS[idx % OFFICE_SEATS.length]!;
          const rig = getOrAddRig(actor, seat, idx);
          const sim = simById.get(actor.id);

          let desiredPos = { x: seat.x, z: seat.z };
          let desiredYaw = seat.angle;
          let shouldSit = true;
          let speed = WALK_SPEED;
          let action: string | undefined;

          if (actor.id === OWNER_SEAT_ID && ownerWantsMeeting) {
            // The owner stands at his head chair and plays the speaking or arguing pose
            desiredPos = { x: seat.x, z: seat.z };
            desiredYaw = seat.angle;
            shouldSit = false;
            speed = OWNER_WALK_SPEED;
            if (actor.facing) {
              const opponent = charRigs.get(actor.facing);
              if (opponent) desiredYaw = Math.atan2(opponent.pos.x - rig.pos.x, opponent.pos.z - rig.pos.z);
            } else {
              desiredYaw = Math.atan2(-rig.pos.x, -rig.pos.z);
            }
          } else if (actor.id === OWNER_SEAT_ID) {
            // Idle: the owner's sim spot (home chair, window or bar)
            const point = getInteractionPoint(sim?.currentPointId ?? "");
            if (point) {
              desiredPos = { x: point.x, z: point.z };
              desiredYaw = point.approachAngle;
              shouldSit = point.pose === "typing" || point.pose === "sitting_sofa";
              action = actionForPoint(point.kind, point.pose);
            }
          } else if (actor.activity === "speaking" || actor.activity === "arguing") {
            // Stand at the speaker spot, facing the seat answered or the table centre
            desiredPos = { x: seat.speakX, z: seat.speakZ };
            shouldSit = false;
            if (actor.facing) {
              const opponent = charRigs.get(actor.facing);
              if (opponent) desiredYaw = Math.atan2(opponent.pos.x - rig.pos.x, opponent.pos.z - rig.pos.z);
            } else {
              desiredYaw = Math.atan2(-rig.pos.x, -rig.pos.z);
            }
          } else if (actor.activity === "waiting") {
            // Gathered at the meeting chair, turned towards the speaker
            desiredPos = { x: seat.x, z: seat.z };
            shouldSit = true;
            const speakerRig = activeSpeaker ? charRigs.get(activeSpeaker.id) : undefined;
            if (speakerRig) desiredYaw = Math.atan2(speakerRig.pos.x - rig.pos.x, speakerRig.pos.z - rig.pos.z);
          } else if (sim) {
            // Idle: the simulation's spot (desk, sofa, coffee, window, chat or report)
            const point = getInteractionPoint(sim.currentPointId);
            if (point) {
              desiredPos = { x: point.x, z: point.z };
              desiredYaw = point.approachAngle;
              shouldSit = point.pose === "typing" || point.pose === "sitting_sofa";
              action = actionForPoint(point.kind, point.pose);
            }
          }

          rig.targetSit = shouldSit;
          rig.action = action;

          const distToDesired = Math.hypot(rig.target.x - desiredPos.x, rig.target.z - desiredPos.z);
          rig.targetYaw = desiredYaw;
          if (distToDesired > 0.15) {
            rig.target = { x: desiredPos.x, z: desiredPos.z };
            if (motionReduced || snap) {
              rig.pos = { x: desiredPos.x, z: desiredPos.z };
              rig.path = [];
            } else {
              rig.path = findOfficePath(rig.pos, rig.target);
            }
          }

          // Walk along the path at bounded speed. A character waits when a standing one blocks the next step.
          if (rig.path.length > 0 && !motionReduced) {
            const nextWaypoint = rig.path[0]!;
            const blockedBy = [...charRigs.entries()].some(([id, other]) =>
              id !== actor.id && !other.walking &&
              Math.hypot(other.pos.x - nextWaypoint.x, other.pos.z - nextWaypoint.z) < 0.35
            );
            if (blockedBy && rig.blockedSeconds < 2.5) {
              rig.blockedSeconds += dt;
              rig.walking = false;
            } else {
              rig.blockedSeconds = 0;
              const stepResult = walkStep(rig.pos, nextWaypoint, speed, dt);
              rig.pos = { x: stepResult.x, z: stepResult.z };
              rig.walking = true;
              rig.walkTick += dt * 10;
              const angleDiff = Math.atan2(Math.sin(stepResult.heading - rig.yaw), Math.cos(stepResult.heading - rig.yaw));
              rig.yaw += Math.sign(angleDiff) * Math.min(Math.abs(angleDiff), 9.0 * dt);
              if (stepResult.reached) rig.path.shift();
            }
          } else {
            rig.walking = false;
            const angleDiff = Math.atan2(Math.sin(rig.targetYaw - rig.yaw), Math.cos(rig.targetYaw - rig.yaw));
            rig.yaw += Math.sign(angleDiff) * Math.min(Math.abs(angleDiff), 7.0 * dt);
          }

          // Sitting / standing transition
          if (rig.targetSit && !rig.walking) {
            rig.sitProgress = Math.min(1, rig.sitProgress + 3.0 * dt);
          } else {
            rig.sitProgress = Math.max(0, rig.sitProgress - 3.0 * dt);
          }

          rig.group.position.set(rig.pos.x, 0, rig.pos.z);
          rig.group.rotation.y = rig.yaw;

          const pose = getOfficePose(actor.activity, {
            tick: timeSec + rig.phase,
            isWalking: rig.walking,
            sittingProgress: rig.sitProgress,
            action: rig.action,
          });

          rig.body.position.y = pose.bodyY;
          rig.headGroup.position.y = pose.headY;
          rig.headGroup.rotation.x = pose.headPitch;
          rig.headGroup.rotation.y = pose.headYaw;

          // Blinking
          const isBlink = (Math.floor((timeSec + rig.phase) * 3) % 11) === 0;
          rig.leftEye.scale.y = isBlink ? 0.15 : 1.0;
          rig.rightEye.scale.y = isBlink ? 0.15 : 1.0;

          rig.leftArmPivot.rotation.x = pose.leftArmPitch;
          rig.rightArmPivot.rotation.x = pose.rightArmPitch;
          rig.leftArmPivot.rotation.y = pose.leftArmYaw;
          rig.rightArmPivot.rotation.y = pose.rightArmYaw;
          rig.leftArmPivot.rotation.z = pose.leftArmRoll;
          rig.rightArmPivot.rotation.z = pose.rightArmRoll;

          rig.leftLegPivot.rotation.x = pose.leftLegPitch;
          rig.rightLegPivot.rotation.x = pose.rightLegPitch;

          // The character being answered turns to face the speaker
          if (actor.activity === "arguing" && actor.facing) {
            const opponent = charRigs.get(actor.facing);
            if (opponent) {
              const angleToSpeaker = Math.atan2(rig.pos.x - opponent.pos.x, rig.pos.z - opponent.pos.z);
              opponent.headGroup.rotation.y = Math.max(-0.6, Math.min(0.6, angleToSpeaker - opponent.yaw));
            }
          }
        });
        snapRef.current = false;

        // Name tags, bubbles and reactions: projected HTML overlays with collision resolution
        const w = container.clientWidth || 320;
        const h = container.clientHeight || 240;

        const rawLabels = currentActors.map((actor) => {
          const rig = charRigs.get(actor.id);
          const label = actor.label.slice(0, LABEL_MAX_CHARS);
          const projPos = new THREE.Vector3(
            rig ? rig.pos.x : 0,
            rig ? rig.headGroup.position.y * RIG_SCALE + 0.45 : 1.2,
            rig ? rig.pos.z : 0
          );
          projPos.project(camera);
          const screenX = Math.round(((projPos.x + 1) * w) / 2);
          const screenY = Math.round(((-projPos.y + 1) * h) / 2);
          const isSpeaker = actor.activity === "speaking" || actor.activity === "arguing";
          return {
            id: actor.id,
            x: screenX,
            y: screenY,
            width: label.length * LABEL_CHAR_WIDTH + 8,
            height: LABEL_HEIGHT,
            isSpeaker,
          };
        });

        const resolvedLabels = resolveLabelCollisions(rawLabels, { width: w, height: h });
        const resolvedMap = new Map(resolvedLabels.map((r) => [r.id, r]));

        currentActors.forEach((actor) => {
          const overlayEl = overlayMapRef.current.get(actor.id);
          const r = resolvedMap.get(actor.id);
          if (overlayEl && r) {
            const isFlipped = r.y < 110;
            overlayEl.setAttribute("data-flipped", isFlipped ? "true" : "false");
            overlayEl.setAttribute("data-collapsed", r.collapsed ? "true" : "false");
            overlayEl.style.transform = `translate3d(${r.x}px, ${r.y}px, 0)`;
          }
        });

        renderer.render(scene, camera);
        animId = requestAnimationFrame(animate);
      };

      animId = requestAnimationFrame(animate);

      return () => {
        disposed = true;
        if (animId !== null) cancelAnimationFrame(animId);
        if (resizeObserver) resizeObserver.disconnect();
        for (const item of disposables) {
          try {
            item.dispose();
          } catch {
            // Disposing an already released resource is harmless
          }
        }
        try {
          renderer.dispose();
          renderer.forceContextLoss();
        } catch {
          // The context may already be lost
        }
      };
    }

    const cleanupPromise = initThree();

    return () => {
      disposed = true;
      if (animId !== null) cancelAnimationFrame(animId);
      if (resizeObserver) resizeObserver.disconnect();
      void cleanupPromise.then((cleanup) => {
        if (typeof cleanup === "function") cleanup();
      });
    };
  }, [hasWebGL]);

  // Moderator message presence (wall-speaker notice when selected or replayed)
  const activeMsg = cursor !== null ? detail.messages.find((m) => m.seq === cursor) : null;
  const isModeratorActive = (cursor !== null && activeMsg?.seatId === "moderator") || highlightSeatId === "moderator";
  const moderatorMsg = (cursor !== null && activeMsg?.seatId === "moderator")
    ? activeMsg
    : highlightSeatId === "moderator"
    ? detail.messages.slice().reverse().find((m) => m.seatId === "moderator")
    : null;

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 select-none overflow-hidden bg-[#acddec] font-mono text-xs touch-pan-x touch-pan-y"
      style={{ boxShadow: "inset 0 0 0 2px #0f172a", imageRendering: "pixelated" }}
      data-testid="council-office"
    >
      {/* Wall-speaker Moderator Notice, under the top bar */}
      {isModeratorActive && moderatorMsg ? (
        <div
          className="pointer-events-auto absolute top-[60px] left-1/2 -translate-x-1/2 z-20 max-w-[360px] bg-slate-900/90 px-3 py-1.5 text-[11px] font-sans text-amber-300 border-2 border-amber-400 shadow-[2px_2px_0_#0f172a] animate-in fade-in"
          data-testid="council-moderator-notice"
        >
          <div className="font-mono text-[9px] font-bold text-amber-400 uppercase flex items-center gap-1.5 mb-0.5">
            <span>📢</span>
            <span>{t("councilModerator")}</span>
          </div>
          <div className="line-clamp-3 leading-snug text-slate-100">
            <TypewriterText text={formatBubbleText(moderatorMsg.text, 120)} />
          </div>
        </div>
      ) : null}

      {!hasWebGL ? (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[#acddec] p-4 text-center text-slate-900"
          data-testid="council-office-fallback"
        >
          <div className="text-sm font-bold tracking-wider text-slate-900">[OFFICE · 8-BIT]</div>
          <div>{t("councilOfficeFallback")}</div>
          <div className="flex flex-wrap justify-center gap-2 mt-2">
            {actors.map((actor) => (
              <span
                key={actor.id}
                className="px-2 py-0.5 border border-slate-900 bg-white/70 text-[11px]"
                style={{ borderColor: actor.color, color: actor.color }}
              >
                {actor.label}: {actor.activity}
              </span>
            ))}
          </div>
        </div>
      ) : (
        <>
          <canvas
            ref={canvasRef}
            className="absolute inset-0 h-full w-full block"
            style={{ imageRendering: "pixelated" }}
          />

          {/* Projected HTML overlays: name tags, typewriter speech bubbles, listener reactions */}
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            {actors.map((actor) => {
              const isHighlighted = highlightSeatId === actor.id;
              const hasBubble = Boolean(actor.bubble);
              const reaction = reactionGlyphs[actor.id];

              return (
                <div
                  key={actor.id}
                  ref={(el) => {
                    if (el) {
                      overlayMapRef.current.set(actor.id, el);
                    } else {
                      overlayMapRef.current.delete(actor.id);
                    }
                  }}
                  data-flipped="false"
                  className="pointer-events-auto absolute left-0 top-0 flex flex-col items-center -translate-x-1/2 transition-[filter,opacity] duration-150 will-change-transform data-[flipped=true]:translate-y-2 data-[flipped=true]:flex-col-reverse data-[flipped=false]:-translate-y-full"
                  style={{ transform: "translate3d(-9999px, -9999px, 0)" }}
                  onClick={() => onSelectSpeaker?.(actor.id)}
                >
                  {reaction ? (
                    <div
                      className="mb-1 bg-amber-200 px-1.5 py-0.5 text-xs font-mono font-bold text-slate-900 border border-slate-900 animate-bounce"
                      style={{ boxShadow: "1px 1px 0 #0f172a" }}
                    >
                      {reaction}
                    </div>
                  ) : null}

                  {hasBubble ? (
                    <div
                      className="mb-1 max-w-[220px] break-words bg-amber-50 px-2.5 py-1.5 text-[11px] font-sans text-slate-900 border-2 border-slate-900 animate-in fade-in"
                      style={{ boxShadow: "2px 2px 0 #0f172a" }}
                    >
                      <div className="font-mono text-[9px] font-bold text-slate-500 uppercase flex items-center justify-between gap-1">
                        <span>{actor.label}</span>
                        {actor.bubble === "…" ? (
                          <span className="animate-pulse text-amber-600 font-bold">●●●</span>
                        ) : null}
                      </div>
                      <div className="line-clamp-3 leading-snug font-medium">
                        {actor.bubble === "…" ? (
                          <span className="font-mono text-xs text-slate-600">…</span>
                        ) : (
                          <TypewriterText text={actor.bubble!} />
                        )}
                      </div>
                    </div>
                  ) : null}

                  {/* Name tag: 9 px, one line, at most ten characters; collapses to a dot when crowded */}
                  <div
                    className={`group relative px-1 py-px text-[9px] font-bold uppercase tracking-wider text-white border cursor-pointer whitespace-nowrap transition-all ${
                      isHighlighted ? "scale-110 ring-2 ring-white" : ""
                    }`}
                    style={{
                      backgroundColor: actor.color,
                      borderColor: "#282a36",
                    }}
                    title={actor.label}
                  >
                    <span className="hidden group-data-[collapsed=true]:inline font-mono">●</span>
                    <span className="group-data-[collapsed=true]:hidden">
                      {actor.label.length > LABEL_MAX_CHARS ? `${actor.label.slice(0, LABEL_MAX_CHARS - 1)}…` : actor.label}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function TypewriterText({ text }: { text: string }) {
  const [displayedLength, setDisplayedLength] = useState(() => (text.length <= 15 ? text.length : 12));

  useEffect(() => {
    if (text.length <= 15) {
      setDisplayedLength(text.length);
      return;
    }
    setDisplayedLength(12);
    let current = 12;
    const interval = setInterval(() => {
      current += 4;
      if (current >= text.length) {
        setDisplayedLength(text.length);
        clearInterval(interval);
      } else {
        setDisplayedLength(current);
      }
    }, 45);
    return () => clearInterval(interval);
  }, [text]);

  return <>{text.slice(0, displayedLength)}</>;
}
