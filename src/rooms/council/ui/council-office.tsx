import { useEffect, useRef, useState } from "react";
import { t } from "@lane-pilot/i18n";
import { buildOfficeDiorama } from "./office-scene";
import {
  assignOfficeSeats,
  chooseIdleSpot,
  deriveOfficeActors,
  findOfficePath,
  formatBubbleText,
  getOfficePose,
  seatColor,
  walkStep,
  OFFICE_SEATS,
  OFFICE_SPOTS,
  type CouncilDetailLike,
  type OfficeActor,
  type OfficeSeat,
} from "./office-behaviour";

export type CouncilOfficeProps = {
  detail: CouncilDetailLike;
  cursor: number | null;
  highlightSeatId?: string | null;
  onSelectSpeaker?: (seatId: string) => void;
};

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

const HAIR_PALETTE = ["#291d10", "#18181b", "#ca8a04", "#78350f", "#475569", "#b45309"];
function getHairProps(id: string): { color: string; style: number } {
  if (id === "chair") return { color: "#64748b", style: 0 };
  if (id === "owner") return { color: "#18181b", style: 1 };
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return {
    color: HAIR_PALETTE[hash % HAIR_PALETTE.length]!,
    style: (hash >>> 4) % 3,
  };
}

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

  // Mutable refs so animation loop never closes over stale props and does not recreate scene
  const detailRef = useRef(detail);
  const cursorRef = useRef(cursor);
  const highlightSeatIdRef = useRef(highlightSeatId);
  detailRef.current = detail;
  cursorRef.current = cursor;
  highlightSeatIdRef.current = highlightSeatId;

  // DOM node references for projected HTML overlays (updated directly via ref transforms)
  const overlayMapRef = useRef(new Map<string, HTMLDivElement>());

  // Sync actors for React content (text, bubbles, highlight)
  useEffect(() => {
    const syncActors = () => {
      setActors(deriveOfficeActors(detailRef.current, cursorRef.current, Date.now()));
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
          alpha: true,
          powerPreference: "low-power",
        });
      } catch {
        setHasWebGL(false);
        return;
      }

      const scene = new THREE.Scene();

      // Flat pixel-styled ambient + directional lighting
      const ambientLight = new THREE.AmbientLight(0xffffff, 0.85);
      scene.add(ambientLight);

      const dirLight = new THREE.DirectionalLight(0xfff5ea, 0.65);
      dirLight.position.set(10, 15, 10);
      scene.add(dirLight);

      // Isometric camera setup
      const aspect = container.clientWidth / (container.clientHeight || 1);
      const viewSize = 14.5;
      const camera = new THREE.OrthographicCamera(
        (-viewSize * aspect) / 2,
        (viewSize * aspect) / 2,
        viewSize / 2,
        -viewSize / 2,
        0.1,
        1000
      );
      camera.position.set(12, 14, 12);
      camera.lookAt(0, 0, 0);

      const disposables: Array<{ dispose: () => void }> = [];

      const createMat = (color: number | string) => {
        const mat = new THREE.MeshLambertMaterial({ color });
        disposables.push(mat);
        return mat;
      };
      const createBoxGeom = (w: number, h: number, d: number) => {
        const geom = new THREE.BoxGeometry(w, h, d);
        disposables.push(geom);
        return geom;
      };

      // Crisp dark outline material for diorama props & character meshes
      const outlineMat = new THREE.LineBasicMaterial({
        color: 0x0f172a,
        transparent: true,
        opacity: 0.85,
      });
      disposables.push(outlineMat);

      const createCharBox = (w: number, h: number, d: number, mat: import("three").Material) => {
        const geom = createBoxGeom(w, h, d);
        const mesh = new THREE.Mesh(geom, mat);
        const edges = new THREE.EdgesGeometry(geom);
        disposables.push(edges);
        mesh.add(new THREE.LineSegments(edges, outlineMat));
        return mesh;
      };

      // Build bright cutaway diorama office with all props and outlines
      buildOfficeDiorama({ THREE, scene, disposables });

      // --- Character Mesh Management ---
      type CharActorObj = {
        group: import("three").Group;
        body: import("three").Mesh;
        headGroup: import("three").Group;
        headMesh: import("three").Mesh;
        leftArmPivot: import("three").Group;
        rightArmPivot: import("three").Group;
        leftLegPivot: import("three").Group;
        rightLegPivot: import("three").Group;
        currentPos: { x: number; z: number };
        targetPos: { x: number; z: number };
        path: Array<{ x: number; z: number }>;
        yaw: number;
        targetYaw: number;
        isWalking: boolean;
        walkTick: number;
        sittingProgress: number;
        targetSitting: boolean;
        assignedSeat: OfficeSeat;
        spotKey: string | null;
        idleAction?: "coffee" | "window" | "typing" | "bookshelf" | "plant";
        lastSpotChangeTime: number;
        phase: number;
      };

      const charObjects = new Map<string, CharActorObj>();
      const occupiedSpots = new Set<string>();

      const getOrAddChar = (
        actor: OfficeActor,
        seat: OfficeSeat,
        index: number
      ): CharActorObj => {
        let char = charObjects.get(actor.id);
        if (!char) {
          const group = new THREE.Group();
          const charMat = createMat(actor.color);
          const skinMat = createMat(0xfcd34d);
          const pantsMat = createMat(0x1e293b);
          const shoeMat = createMat(0x0f172a);
          const eyeMat = createMat(0x09090b);

          // Head with hair and eyes (outlined)
          const headGroup = new THREE.Group();
          headGroup.position.y = 1.35;

          const headMesh = createCharBox(0.42, 0.42, 0.42, skinMat);
          headGroup.add(headMesh);

          // Eyes
          const leftEye = createCharBox(0.06, 0.08, 0.04, eyeMat);
          leftEye.position.set(-0.1, 0.02, 0.22);
          headGroup.add(leftEye);

          const rightEye = createCharBox(0.06, 0.08, 0.04, eyeMat);
          rightEye.position.set(0.1, 0.02, 0.22);
          headGroup.add(rightEye);

          // Hair variation per seat
          const hairInfo = getHairProps(actor.id);
          const hairMat = createMat(hairInfo.color);
          const hairTop = createCharBox(0.44, 0.16, 0.44, hairMat);
          hairTop.position.set(0, 0.16, -0.02);
          headGroup.add(hairTop);

          if (hairInfo.style === 1) {
            const bangs = createCharBox(0.44, 0.1, 0.1, hairMat);
            bangs.position.set(0, 0.14, 0.2);
            headGroup.add(bangs);
          } else if (hairInfo.style === 2) {
            const leftLock = createCharBox(0.08, 0.22, 0.36, hairMat);
            leftLock.position.set(-0.21, 0.05, 0.02);
            headGroup.add(leftLock);
            const rightLock = createCharBox(0.08, 0.22, 0.36, hairMat);
            rightLock.position.set(0.21, 0.05, 0.02);
            headGroup.add(rightLock);
          }
          group.add(headGroup);

          // Body / Shirt (0.5 x 0.55 x 0.32, outlined)
          const body = createCharBox(0.5, 0.55, 0.32, charMat);
          body.position.y = 0.88;
          group.add(body);

          // Arms with Shoulder Pivots
          const createArmPivot = (isLeft: boolean) => {
            const pivot = new THREE.Group();
            pivot.position.set(isLeft ? -0.32 : 0.32, 1.1, 0);

            // Sleeve
            const sleeve = createCharBox(0.14, 0.28, 0.14, charMat);
            sleeve.position.set(0, -0.14, 0);
            pivot.add(sleeve);

            // Hand
            const hand = createCharBox(0.12, 0.14, 0.12, skinMat);
            hand.position.set(0, -0.32, 0);
            pivot.add(hand);

            return pivot;
          };

          const leftArmPivot = createArmPivot(true);
          group.add(leftArmPivot);

          const rightArmPivot = createArmPivot(false);
          group.add(rightArmPivot);

          // Legs & Shoes with Hip Pivots
          const createLegPivot = (isLeft: boolean) => {
            const pivot = new THREE.Group();
            pivot.position.set(isLeft ? -0.14 : 0.14, 0.55, 0);

            // Pants
            const pants = createCharBox(0.16, 0.45, 0.18, pantsMat);
            pants.position.set(0, -0.22, 0);
            pivot.add(pants);

            // Shoe
            const shoe = createCharBox(0.18, 0.12, 0.24, shoeMat);
            shoe.position.set(0, -0.48, 0.03);
            pivot.add(shoe);

            return pivot;
          };

          const leftLegPivot = createLegPivot(true);
          group.add(leftLegPivot);

          const rightLegPivot = createLegPivot(false);
          group.add(rightLegPivot);

          // Initial spawn: sitting at its assigned chair
          group.position.set(seat.x, 0, seat.z);
          group.rotation.y = seat.angle;
          scene.add(group);

          char = {
            group,
            body,
            headGroup,
            headMesh,
            leftArmPivot,
            rightArmPivot,
            leftLegPivot,
            rightLegPivot,
            currentPos: { x: seat.x, z: seat.z },
            targetPos: { x: seat.x, z: seat.z },
            path: [],
            yaw: seat.angle,
            targetYaw: seat.angle,
            isWalking: false,
            walkTick: index * 1.5,
            sittingProgress: 1.0,
            targetSitting: true,
            assignedSeat: seat,
            spotKey: null,
            lastSpotChangeTime: Date.now() + index * 900,
            phase: index * 1.7,
          };
          charObjects.set(actor.id, char);
        }
        return char;
      };

      const handleResize = () => {
        if (!container || !renderer) return;
        const w = container.clientWidth || 320;
        const h = container.clientHeight || 240;
        const scale = 3;
        const pixelW = Math.max(100, Math.floor(w / scale));
        const pixelH = Math.max(80, Math.floor(h / scale));

        renderer.setSize(pixelW, pixelH, false);
        const newAspect = w / h;
        camera.left = (-viewSize * newAspect) / 2;
        camera.right = (viewSize * newAspect) / 2;
        camera.top = viewSize / 2;
        camera.bottom = -viewSize / 2;
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
      const WALK_SPEED = 2.0;

      const animate = (nowTime: number) => {
        if (disposed) return;
        const dt = Math.min(0.1, Math.max(0.001, (nowTime - lastTime) / 1000));
        lastTime = nowTime;
        const nowMs = Date.now();
        const timeSec = nowTime / 1000;

        // Read current state through mutable refs
        const currentDetail = detailRef.current;
        const currentCursor = cursorRef.current;
        const currentHighlight = highlightSeatIdRef.current;
        const currentActors = deriveOfficeActors(currentDetail, currentCursor, nowMs);

        // Seat assignments for all actors
        const seatAssignments = assignOfficeSeats(currentActors);

        // Active speaker ID (for listener attention and reactions)
        const activeSpeaker = currentActors.find(
          (a) => a.activity === "speaking" || a.activity === "arguing"
        );

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

        // Update each character
        currentActors.forEach((actor, idx) => {
          const seat = seatAssignments.get(actor.id) ?? OFFICE_SEATS[idx % OFFICE_SEATS.length]!;
          const char = getOrAddChar(actor, seat, idx);

          let desiredPos = { x: seat.x, z: seat.z };
          let desiredYaw = seat.angle;
          let shouldSit = true;

          if (actor.activity === "speaking" || actor.activity === "arguing") {
            // Stand beside chair at meeting table
            desiredPos = { x: seat.speakX, z: seat.speakZ };
            shouldSit = false;

            // Facing logic: face opponent if arguing, else face table center
            if (actor.facing) {
              const opponent = charObjects.get(actor.facing);
              if (opponent) {
                const dx = opponent.currentPos.x - char.currentPos.x;
                const dz = opponent.currentPos.z - char.currentPos.z;
                desiredYaw = Math.atan2(dx, dz);
              }
            } else {
              desiredYaw = Math.atan2(-char.currentPos.x, -char.currentPos.z);
            }

            // Release any previously held spot
            if (char.spotKey) {
              occupiedSpots.delete(char.spotKey);
              char.spotKey = null;
            }
          } else if (actor.activity === "waiting") {
            // Sits at table seat
            desiredPos = { x: seat.x, z: seat.z };
            shouldSit = true;

            // If someone is speaking or arguing, look towards the speaker!
            if (activeSpeaker) {
              const speakerChar = charObjects.get(activeSpeaker.id);
              if (speakerChar) {
                const dx = speakerChar.currentPos.x - char.currentPos.x;
                const dz = speakerChar.currentPos.z - char.currentPos.z;
                desiredYaw = Math.atan2(dx, dz);
              } else {
                desiredYaw = seat.angle;
              }
            } else {
              desiredYaw = seat.angle;
            }

            if (char.spotKey) {
              occupiedSpots.delete(char.spotKey);
              char.spotKey = null;
            }
          } else if (actor.activity === "idle") {
            // Wandering to an office spot
            if (!motionReduced) {
              shouldSit = false;
              if (
                !char.spotKey ||
                nowMs - char.lastSpotChangeTime > 5000 + (idx % 4) * 1800
              ) {
                const nextSpotKey = chooseIdleSpot(occupiedSpots, Math.random, char.spotKey);
                if (nextSpotKey && OFFICE_SPOTS[nextSpotKey]) {
                  if (char.spotKey) occupiedSpots.delete(char.spotKey);
                  char.spotKey = nextSpotKey;
                  occupiedSpots.add(nextSpotKey);
                  const spot = OFFICE_SPOTS[nextSpotKey]!;
                  char.idleAction = spot.action;
                  char.lastSpotChangeTime = nowMs;
                }
              }

              if (char.spotKey && OFFICE_SPOTS[char.spotKey]) {
                const spot = OFFICE_SPOTS[char.spotKey]!;
                desiredPos = { x: spot.x, z: spot.z };
                desiredYaw = spot.angle;
              }
            } else {
              desiredPos = { x: seat.x, z: seat.z };
              desiredYaw = seat.angle;
              shouldSit = true;
            }
          }

          char.targetSitting = shouldSit;

          // If desired destination changed significantly, re-plan path
          const distToDesired = Math.hypot(
            char.targetPos.x - desiredPos.x,
            char.targetPos.z - desiredPos.z
          );
          if (distToDesired > 0.15) {
            char.targetPos = { x: desiredPos.x, z: desiredPos.z };
            char.targetYaw = desiredYaw;
            if (motionReduced) {
              char.currentPos = { x: desiredPos.x, z: desiredPos.z };
              char.path = [];
            } else {
              char.path = findOfficePath(char.currentPos, char.targetPos);
            }
          } else {
            char.targetYaw = desiredYaw;
          }

          // Walk along path at bounded speed without teleporting
          if (char.path.length > 0 && !motionReduced) {
            const nextWaypoint = char.path[0]!;
            const stepResult = walkStep(char.currentPos, nextWaypoint, WALK_SPEED, dt);
            char.currentPos = { x: stepResult.x, z: stepResult.z };
            char.isWalking = true;
            char.walkTick += dt * 10;

            // Turn smoothly towards heading
            const angleDiff = Math.atan2(
              Math.sin(stepResult.heading - char.yaw),
              Math.cos(stepResult.heading - char.yaw)
            );
            char.yaw += Math.sign(angleDiff) * Math.min(Math.abs(angleDiff), 9.0 * dt);

            if (stepResult.reached) {
              char.path.shift();
            }
          } else {
            char.isWalking = false;
            // Smoothly turn to target orientation when stationary
            const angleDiff = Math.atan2(
              Math.sin(char.targetYaw - char.yaw),
              Math.cos(char.targetYaw - char.yaw)
            );
            char.yaw += Math.sign(angleDiff) * Math.min(Math.abs(angleDiff), 7.0 * dt);
          }

          // Sitting / standing transition
          if (char.targetSitting && !char.isWalking) {
            char.sittingProgress = Math.min(1, char.sittingProgress + 3.0 * dt);
          } else {
            char.sittingProgress = Math.max(0, char.sittingProgress - 3.0 * dt);
          }

          char.group.position.set(char.currentPos.x, 0, char.currentPos.z);
          char.group.rotation.y = char.yaw;

          // Compute pose and apply to character limbs
          const pose = getOfficePose(actor.activity, {
            tick: timeSec + char.phase,
            isWalking: char.isWalking,
            sittingProgress: char.sittingProgress,
            action: char.idleAction,
          });

          char.body.position.y = pose.bodyY;
          char.headGroup.position.y = pose.headY;
          char.headGroup.rotation.x = pose.headPitch;
          char.headGroup.rotation.y = pose.headYaw;

          char.leftArmPivot.rotation.x = pose.leftArmPitch;
          char.rightArmPivot.rotation.x = pose.rightArmPitch;
          char.leftArmPivot.rotation.y = pose.leftArmYaw;
          char.rightArmPivot.rotation.y = pose.rightArmYaw;
          char.leftArmPivot.rotation.z = pose.leftArmRoll;
          char.rightArmPivot.rotation.z = pose.rightArmRoll;

          char.leftLegPivot.rotation.x = pose.leftLegPitch;
          char.rightLegPivot.rotation.x = pose.rightLegPitch;

          // If arguing, opponent turns toward speaker
          if (actor.activity === "arguing" && actor.facing) {
            const opp = charObjects.get(actor.facing);
            if (opp) {
              const dx = char.currentPos.x - opp.currentPos.x;
              const dz = char.currentPos.z - opp.currentPos.z;
              const oppOppAngle = Math.atan2(dx, dz);
              opp.headGroup.rotation.y = Math.max(-0.6, Math.min(0.6, oppOppAngle - opp.yaw));
            }
          }

          // Direct DOM transform update for overlay (avoid React re-rendering every frame)
          const overlayEl = overlayMapRef.current.get(actor.id);
          if (overlayEl) {
            const projPos = new THREE.Vector3(
              char.currentPos.x,
              char.headGroup.position.y + 0.45,
              char.currentPos.z
            );
            projPos.project(camera);

            const w = container.clientWidth || 320;
            const h = container.clientHeight || 240;
            const screenX = Math.round(((projPos.x + 1) * w) / 2);
            const screenY = Math.round(((-projPos.y + 1) * h) / 2);

            // Clamp inside office bounds so speech bubbles and tags don't clip horizontally
            const adjX = Math.max(90, Math.min(w - 90, screenX));
            // When close to top, flip bubble below head
            const isFlipped = screenY < 110;
            const adjY = isFlipped ? Math.max(10, screenY) : Math.min(h - 10, screenY);

            overlayEl.setAttribute("data-flipped", isFlipped ? "true" : "false");
            overlayEl.style.transform = `translate3d(${adjX}px, ${adjY}px, 0)`;
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
            // ignore
          }
        }
        try {
          renderer.dispose();
        } catch {
          // ignore
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
      className="relative flex h-full w-full min-h-[220px] select-none flex-col items-center justify-center overflow-hidden bg-[#cbd5e1] text-xs font-mono"
      style={{
        boxShadow: "inset 0 0 0 2px #0f172a",
        imageRendering: "pixelated",
      }}
      data-testid="council-office"
    >
      {/* Wall-speaker Moderator Notice */}
      {isModeratorActive && moderatorMsg ? (
        <div
          className="pointer-events-auto absolute top-2.5 left-1/2 -translate-x-1/2 z-20 max-w-[320px] rounded bg-slate-900/90 px-3 py-1.5 text-[11px] font-sans text-amber-300 border-2 border-amber-400 shadow-[2px_2px_0_#0f172a] animate-in fade-in"
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
          className="flex flex-col items-center justify-center gap-2 p-4 text-center text-slate-300"
          data-testid="council-office-fallback"
        >
          <div className="text-sm font-bold tracking-wider text-amber-400">
            [OFFICE · 8-BIT]
          </div>
          <div>{t("councilOfficeFallback")}</div>
          <div className="flex flex-wrap justify-center gap-2 mt-2">
            {actors.map((actor) => (
              <span
                key={actor.id}
                className="px-2 py-0.5 rounded border text-[11px]"
                style={{
                  borderColor: actor.color,
                  backgroundColor: `${actor.color}22`,
                  color: actor.color,
                }}
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
            className="h-full w-full block"
            style={{ imageRendering: "pixelated" }}
          />

          {/* Projected HTML Overlays: Name tags, typewriter speech bubbles, listener reactions */}
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
                  {/* Listener reaction bubble */}
                  {reaction ? (
                    <div
                      className="mb-1 rounded bg-amber-200 px-1.5 py-0.5 text-xs font-mono font-bold text-slate-900 border border-slate-900 animate-bounce"
                      style={{ boxShadow: "1px 1px 0 #0f172a" }}
                    >
                      {reaction}
                    </div>
                  ) : null}

                  {/* Speech bubble with typewriter text */}
                  {hasBubble ? (
                    <div
                      className="mb-1 max-w-[210px] break-words rounded bg-amber-50 px-2.5 py-1.5 text-[11px] font-sans text-slate-900 border-2 border-slate-900 animate-in fade-in"
                      style={{
                        boxShadow: "2px 2px 0 #0f172a",
                      }}
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

                  {/* Character label tag */}
                  <div
                    className={`px-1 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white border-2 cursor-pointer transition-all ${
                      isHighlighted ? "scale-110 shadow-lg ring-2 ring-white" : ""
                    }`}
                    style={{
                      backgroundColor: actor.color,
                      borderColor: "#0f172a",
                      boxShadow: "1px 1px 0 #0f172a",
                    }}
                  >
                    {actor.label}
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
