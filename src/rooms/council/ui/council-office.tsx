import { useEffect, useRef, useState } from "react";
import { t } from "@lane-pilot/i18n";
import { buildOfficeFloor } from "./office-scene";
import {
  CAMERA_PITCH,
  CAMERA_YAW,
  PIXELS_PER_UNIT,
  PixelPresenter,
  ZOOM_SCALES,
  getPixelStyle,
  sunPosition,
} from "./office-pixel";
import { applyCharacterPose, buildCharacter, pickCharacterLook, type CharacterModel } from "./office-character";
import {
  OFFICE_SEATS,
  OWNER_SEAT_ID,
  RECEPTIONIST_ID,
  STAFF_PREFIX,
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
import {
  CLIP_FADE,
  SEAT_HEIGHT_CHAIR,
  clipForState,
  loadOfficePeople,
  pickPersonVariant,
  seatHeightForPoint,
  walkTimeScale,
  type OfficePeople,
  type Person,
} from "./office-people";
import { loadOfficeCars, type OfficeCars } from "./office-cars";

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
/** The chibi rig is built at 1.6 tall and scaled to read at the contain fit, like the people in the reference picture. */
const RIG_SCALE = 0.88;
const LABEL_HEIGHT = 16;
const LABEL_CHAR_WIDTH = 6.2;
const LABEL_MAX_CHARS = 10;
const OUTLINE_COLOR = 0x282a36;
/** Background staff take the desks the council leaves free; the receptionist is always in. */
const DESK_COUNT = 8;
const MAX_STAFF_WORKERS = 5;
const STAFF_COLORS = ["#e8833a", "#4f9d4a", "#3d7cc9", "#9a5bb5", "#d9a03f", "#c0504d"];
const RECEPTIONIST_COLOR = "#2c9a8f";
const CHAT_GLYPHS = ["…", "ха", "!", "?", "👍", "☕"];

/**
 * Camera: 2:1 dimetric (azimuth 45°, pitch 30°), four views 90° apart, fixed pitch. `zoom` is the
 * CSS pixels per render pixel (one of ZOOM_SCALES); 0 means the largest step that fits the floor.
 */
const VIEW_DEFAULT = { yaw: CAMERA_YAW, pitch: CAMERA_PITCH, zoom: 0, tx: 0, tz: 0 };
/** A drag this long (CSS px) turns the office by one view. */
const TURN_DRAG_PX = 50;
type OfficeView = typeof VIEW_DEFAULT;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function staffIdsFor(councilActorIds: string[]): string[] {
  const council = councilActorIds.filter((id) => id !== OWNER_SEAT_ID).length;
  const workers = clamp(DESK_COUNT - council, 0, MAX_STAFF_WORKERS);
  return [RECEPTIONIST_ID, ...Array.from({ length: workers }, (_, i) => `${STAFF_PREFIX}${i + 1}`)];
}

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

/** Action for the walking pose, from the interaction point the character stands on. */
function actionForPoint(pointKind: string | undefined, pose: string | undefined): string | undefined {
  if (pose === "typing") return "typing";
  if (pose === "window_gaze") return "window";
  if (pose === "operating") return "operate";
  if (pose === "chatting") return "chat";
  if (pointKind === "bar") return "bar";
  if (pose === "drinking" || pointKind === "coffee" || pointKind === "water") return "coffee";
  return undefined;
}

type Rig = {
  group: import("three").Group;
  /** The procedural rig: shown while the rigged people load, or when they cannot. */
  model: CharacterModel | null;
  headGroup: import("three").Group | null;
  /** The rigged person (office-people.glb) once loaded. */
  person: Person | null;
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
  /** Short reactions over people chatting at the coffee point, the open space or the entrance. */
  const [chatGlyphs, setChatGlyphs] = useState<Record<string, string>>({});
  const [staffIds, setStaffIds] = useState<string[]>(() => staffIdsFor(actors.map((a) => a.id)));
  const [viewMoved, setViewMoved] = useState(false);
  const viewTargetRef = useRef<OfficeView>({ ...VIEW_DEFAULT });
  const staffOverlayRef = useRef(new Map<string, HTMLDivElement>());

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
      const nextActors = deriveOfficeActors(detailRef.current, cursorRef.current, now, {
        cursorSelectedAt: cursorSelectedTimeRef.current,
      });
      setActors(nextActors);
      const nextStaff = staffIdsFor(nextActors.map((a) => a.id));
      setStaffIds((prev) => (prev.join("|") === nextStaff.join("|") ? prev : nextStaff));
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
          antialias: false, // the scene is drawn at low resolution and upscaled with nearest sampling
          alpha: false,
          powerPreference: "low-power",
        });
      } catch {
        setHasWebGL(false);
        return;
      }
      // 3D pixel art: low-res target, depth outlines, nearest upscale (office-pixel.ts)
      const presenter = new PixelPresenter(THREE, renderer);

      const scene = new THREE.Scene();
      const disposables: Array<{ dispose: () => void }> = [];

      // Camera: orthographic, azimuth 33°, elevation 30°, target = floor centre
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 500);
      // The view eases towards the target the controls set (frame-rate independent)
      const view: OfficeView = { ...viewTargetRef.current };
      let fitCenterY = 1.3;
      /** The zoom step that fits the whole floor (CSS px per render pixel). */
      let autoScale: number = ZOOM_SCALES[1];
      const pixelStyle = getPixelStyle(THREE);
      const sunLight = { current: null as import("three").DirectionalLight | null };
      const currentScale = (zoom: number) => (zoom > 0 ? zoom : autoScale);
      const applyView = () => {
        presenter.setScale(currentScale(view.zoom));
        presenter.placeCamera(camera, view, fitCenterY);
        pixelStyle.setFrontWalls(view.yaw);
        if (sunLight.current) sunPosition(view.yaw, sunLight.current.position);
      };

      buildOfficeFloor({ THREE, scene, disposables });
      sunLight.current = scene.getObjectByName("sun") as import("three").DirectionalLight | null;
      applyView();

      const outlineMat = new THREE.LineBasicMaterial({ color: OUTLINE_COLOR });
      disposables.push(outlineMat);

      const charRigs = new Map<string, Rig>();
      const characterKit = { THREE, outlineMaterial: outlineMat, disposables };

      /** The rigged people, parsed once in the background; until then (or if that fails) the procedural rig stands in. */
      let people: OfficePeople | null = null;
      const makePerson = (id: string): Person | null => {
        if (!people) return null;
        const others = [...charRigs.entries()].filter(([otherId]) => otherId !== id).flatMap(([, r]) => (r.person ? [r.person.variant] : []));
        try {
          return people.createPerson(pickPersonVariant(id, others));
        } catch {
          return null;
        }
      };

      const buildRig = (actor: OfficeActor, seat: OfficeSeat, index: number): Rig => {
        const person = makePerson(actor.id);
        const model = person ? null : buildCharacter(characterKit, pickCharacterLook(actor.id, actor.color));
        const group = person ? person.root : model!.root;
        if (model) group.scale.setScalar(RIG_SCALE);
        const headGroup = model ? model.headGroup : null;

        group.position.set(seat.x, 0, seat.z);
        group.rotation.y = seat.angle;
        scene.add(group);

        return {
          group,
          model,
          headGroup,
          person,
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

      // The GLB cars replace the box cars of the lot once parsed; the box cars stay if that fails
      let cars: OfficeCars | null = null;
      loadOfficeCars(THREE, scene).then((loaded) => {
        if (disposed) loaded.dispose();
        else cars = loaded;
      }, () => {});

      // Rigged people replace the procedural ones that already stand on the floor once the GLB is parsed
      loadOfficePeople(THREE).then((loaded) => {
        if (disposed) {
          loaded.dispose();
          return;
        }
        people = loaded;
        for (const [id, rig] of charRigs) {
          if (rig.person) continue;
          const person = makePerson(id);
          if (!person) continue;
          person.root.position.copy(rig.group.position);
          person.root.rotation.y = rig.group.rotation.y;
          scene.remove(rig.group);
          scene.add(person.root);
          rig.group = person.root;
          rig.person = person;
          rig.model = null;
          rig.headGroup = null;
        }
      }, () => {
        // The procedural people stay; nothing else to do
      });

      // Behaviour: the same simulation the tests check, re-created when the set of actors changes
      let simAgents: OfficeSimAgent[] = [];
      let simIds = "";
      const reservations = new Map<string, string>();

      const handleResize = () => {
        const w = container.clientWidth || 320;
        const h = container.clientHeight || 240;
        presenter.resize(w, h, Math.min(window.devicePixelRatio || 1, 3));
        const { viewHeight, centerY } = fitOfficeCamera(w / h);
        fitCenterY = centerY;
        // Default: the largest whole-pixel scale at which the building nearly fits; up to 20 % may run past the
        // edges (mostly street and lawn), otherwise a BB panel narrower than the floor gets a tiny 1× office
        autoScale = [...ZOOM_SCALES].reverse().find((step) => viewHeight * PIXELS_PER_UNIT * step <= h * 1.2) ?? ZOOM_SCALES[0];
        applyView();
      };

      // Orbit controls: drag rotates, right/shift-drag or two fingers move, wheel or pinch zooms, double-click resets
      const pointers = new Map<number, { x: number; y: number }>();
      let pinchDistance = 0;
      const target = viewTargetRef.current;
      const markMoved = () => setViewMoved(true);
      let turnDrag = 0;
      /** One zoom step in or out along ZOOM_SCALES from the current scale. */
      const stepZoom = (direction: number) => {
        const now = currentScale(target.zoom);
        const index = ZOOM_SCALES.findIndex((step) => step >= now);
        const from = index < 0 ? ZOOM_SCALES.length - 1 : index;
        target.zoom = ZOOM_SCALES[clamp(from + direction, 0, ZOOM_SCALES.length - 1)]!;
      };
      const panBy = (dxPx: number, dyPx: number) => {
        const unitsPerPx = 1 / (PIXELS_PER_UNIT * currentScale(target.zoom));
        const right = { x: Math.cos(target.yaw), z: -Math.sin(target.yaw) };
        const back = { x: Math.sin(target.yaw), z: Math.cos(target.yaw) };
        const lift = 1 / Math.max(0.3, Math.sin(target.pitch));
        target.tx = clamp(target.tx - (dxPx * right.x + dyPx * -back.x * lift) * unitsPerPx, -20, 20);
        target.tz = clamp(target.tz - (dxPx * right.z + dyPx * -back.z * lift) * unitsPerPx, -10, 10);
      };
      const onPointerDown = (e: PointerEvent) => {
        canvas.setPointerCapture(e.pointerId);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        turnDrag = 0;
        if (pointers.size === 2) {
          const [a, b] = [...pointers.values()];
          pinchDistance = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        }
      };
      const onPointerMove = (e: PointerEvent) => {
        const prev = pointers.get(e.pointerId);
        if (!prev) return;
        const dx = e.clientX - prev.x;
        const dy = e.clientY - prev.y;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size >= 2) {
          const [a, b] = [...pointers.values()];
          const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
          if (pinchDistance > 0 && (dist / pinchDistance > 1.25 || dist / pinchDistance < 0.8)) {
            stepZoom(dist > pinchDistance ? 1 : -1);
            pinchDistance = dist;
          }
          if (pinchDistance === 0) pinchDistance = dist;
          panBy(dx / 2, dy / 2);
        } else if (e.buttons === 2 || e.shiftKey) {
          panBy(dx, dy);
        } else {
          // Dragging turns the office by whole views: each TURN_DRAG_PX of drag is a quarter turn
          turnDrag += dx;
          if (Math.abs(turnDrag) >= TURN_DRAG_PX) {
            target.yaw -= Math.sign(turnDrag) * (Math.PI / 2);
            turnDrag = 0;
          }
        }
        markMoved();
      };
      const onPointerUp = (e: PointerEvent) => {
        pointers.delete(e.pointerId);
        pinchDistance = 0;
      };
      let wheelDelta = 0;
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        wheelDelta += e.deltaY;
        if (Math.abs(wheelDelta) >= 40) {
          stepZoom(wheelDelta < 0 ? 1 : -1);
          wheelDelta = 0;
        }
        markMoved();
      };
      const onDoubleClick = () => {
        Object.assign(target, VIEW_DEFAULT);
        setViewMoved(false);
      };
      const onContextMenu = (e: Event) => e.preventDefault();
      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("pointerup", onPointerUp);
      canvas.addEventListener("pointercancel", onPointerUp);
      canvas.addEventListener("wheel", onWheel, { passive: false });
      canvas.addEventListener("dblclick", onDoubleClick);
      canvas.addEventListener("contextmenu", onContextMenu);
      const removeControls = () => {
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("pointerup", onPointerUp);
        canvas.removeEventListener("pointercancel", onPointerUp);
        canvas.removeEventListener("wheel", onWheel);
        canvas.removeEventListener("dblclick", onDoubleClick);
        canvas.removeEventListener("contextmenu", onContextMenu);
      };

      resizeObserver = new ResizeObserver(handleResize);
      resizeObserver.observe(container);
      handleResize();

      const motionReduced =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      let lastTime = performance.now();
      let lastReactionCheck = Date.now();
      let lastChatGlyph = Date.now();

      /** Moves one character towards its spot (path, waiting for blockers, turning, sitting) and poses it. */
      const driveRig = (
        id: string,
        rig: Rig,
        want: { desiredPos: { x: number; z: number }; desiredYaw: number; shouldSit: boolean; speed: number; action?: string; seatHeight?: number },
        activity: OfficeActor["activity"],
        isNewRig: boolean,
        snap: boolean,
        dt: number,
        timeSec: number
      ) => {
        const { desiredPos, desiredYaw, shouldSit, speed, action } = want;
        rig.targetSit = shouldSit;
        rig.action = action;
        if (isNewRig) {
          // A character appears where it belongs (the owner in his chair), not at a meeting chair
          rig.pos = { x: desiredPos.x, z: desiredPos.z };
          rig.target = { x: desiredPos.x, z: desiredPos.z };
          rig.yaw = desiredYaw;
          rig.sitProgress = shouldSit ? 1 : 0;
        }

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
          const blockedBy = [...charRigs.entries()].some(([otherId, other]) =>
            otherId !== id && !other.walking &&
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

        const pose = getOfficePose(activity, {
          tick: timeSec + rig.phase,
          isWalking: rig.walking,
          sittingProgress: rig.sitProgress,
          action: rig.action,
        });

        if (rig.person) {
          const person = rig.person;
          const sitting = rig.targetSit && !rig.walking;
          person.play(
            clipForState({ walking: rig.walking, sitting, activity, action: rig.action, slot: Math.floor((timeSec + rig.phase) / 7) }),
            CLIP_FADE,
            rig.phase
          );
          person.setTimeScale(walkTimeScale(speed));
          person.setSeat(rig.sitProgress, want.seatHeight ?? SEAT_HEIGHT_CHAIR);
          person.update(dt);
        } else if (rig.model) {
          applyCharacterPose(rig.model, pose, timeSec + rig.phase);
        }
      };

      const projectedPoint = { x: 0, y: 0 };
      const animate = (nowTime: number) => {
        if (disposed) return;
        const dt = Math.min(0.1, Math.max(0.001, (nowTime - lastTime) / 1000));
        lastTime = nowTime;
        const nowMs = Date.now();
        const timeSec = nowTime / 1000;
        if (!motionReduced) cars?.update(dt);

        // Ease the view towards the controls' target: exponential smoothing, independent of frame rate
        const ease = motionReduced ? 1 : 1 - Math.exp(-12 * dt);
        const goal = viewTargetRef.current;
        // Take the short way round after a reset, and land exactly on the snapped view
        view.yaw = goal.yaw + Math.atan2(Math.sin(view.yaw - goal.yaw), Math.cos(view.yaw - goal.yaw));
        if (
          Math.abs(goal.yaw - view.yaw) + Math.abs(goal.pitch - view.pitch) + (goal.zoom === view.zoom ? 0 : 1) +
          Math.abs(goal.tx - view.tx) + Math.abs(goal.tz - view.tz) > 1e-4
        ) {
          view.yaw = Math.abs(goal.yaw - view.yaw) < 2e-3 ? goal.yaw : view.yaw + (goal.yaw - view.yaw) * ease;
          view.pitch = goal.pitch;
          view.zoom = goal.zoom; // pixel zoom steps are not eased
          view.tx += (goal.tx - view.tx) * ease;
          view.tz += (goal.tz - view.tz) * ease;
          applyView();
        }

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
        const currentStaff = staffIdsFor(currentActors.map((a) => a.id));
        const ids = [...currentActors.map((a) => a.id), ...currentStaff].join("|");
        if (ids !== simIds) {
          simIds = ids;
          simAgents = createOfficeAgents(currentActors.map((a) => a.id), currentStaff);
          reservations.clear();
          // Staff that left the floor (a bigger council took their desks) are removed from the scene
          for (const [id, rig] of charRigs) {
            if (id.startsWith(STAFF_PREFIX) && !currentStaff.includes(id)) {
              scene.remove(rig.group);
              rig.person?.dispose();
              charRigs.delete(id);
            }
          }
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
          const isNewRig = !charRigs.has(actor.id);
          const rig = getOrAddRig(actor, seat, idx);
          const sim = simById.get(actor.id);

          let desiredPos = { x: seat.x, z: seat.z };
          let desiredYaw = seat.angle;
          let shouldSit = true;
          let speed = WALK_SPEED;
          let action: string | undefined;
          let seatHeight = SEAT_HEIGHT_CHAIR;

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
              desiredPos = { x: point.seatX ?? point.x, z: point.seatZ ?? point.z };
              desiredYaw = point.approachAngle;
              shouldSit = point.pose === "typing" || point.pose === "sitting_sofa";
              action = actionForPoint(point.kind, point.pose);
              seatHeight = seatHeightForPoint(point.id, point.kind);
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
              desiredPos = { x: point.seatX ?? point.x, z: point.seatZ ?? point.z };
              desiredYaw = point.approachAngle;
              shouldSit = point.pose === "typing" || point.pose === "sitting_sofa";
              action = actionForPoint(point.kind, point.pose);
              seatHeight = seatHeightForPoint(point.id, point.kind);
            }
          }

          driveRig(actor.id, rig, { desiredPos, desiredYaw, shouldSit, speed, action, seatHeight }, actor.activity, isNewRig, snap, dt, timeSec);

          // The character being answered turns to face the speaker
          if (actor.activity === "arguing" && actor.facing) {
            const opponent = charRigs.get(actor.facing);
            if (opponent) {
              const angleToSpeaker = Math.atan2(rig.pos.x - opponent.pos.x, rig.pos.z - opponent.pos.z);
              if (opponent.headGroup) opponent.headGroup.rotation.y = Math.max(-0.6, Math.min(0.6, angleToSpeaker - opponent.yaw));
            }
          }
        });
        // Background staff: their own simulation spots, idle poses, no council duties
        currentStaff.forEach((staffId, idx) => {
          const sim = simById.get(staffId);
          const point = getInteractionPoint(sim?.currentPointId ?? "");
          if (!point) return;
          const isNewRig = !charRigs.has(staffId);
          let rig = charRigs.get(staffId);
          if (!rig) {
            const color = staffId === RECEPTIONIST_ID ? RECEPTIONIST_COLOR : STAFF_COLORS[idx % STAFF_COLORS.length]!;
            const pseudo: OfficeActor = { id: staffId, label: "", color, activity: "idle" };
            const spawn = { id: staffId, seatId: staffId, pointId: point.id, x: point.x, z: point.z, angle: point.approachAngle, speakX: point.x, speakZ: point.z };
            rig = buildRig(pseudo, spawn, currentActors.length + idx + 1);
            charRigs.set(staffId, rig);
          }
          driveRig(staffId, rig, {
            desiredPos: { x: point.seatX ?? point.x, z: point.seatZ ?? point.z },
            desiredYaw: point.approachAngle,
            shouldSit: point.pose === "typing" || point.pose === "sitting_sofa",
            speed: WALK_SPEED,
            action: actionForPoint(point.kind, point.pose),
            seatHeight: seatHeightForPoint(point.id, point.kind),
          }, "idle", isNewRig, snap, dt, timeSec);
        });
        snapRef.current = false;

        // Now and then someone who is chatting says something short
        if (nowMs - lastChatGlyph > 2600) {
          lastChatGlyph = nowMs;
          const chatting = simAgents.filter((a) => (a.activity === "chat" || a.activity === "coffee") && !charRigs.get(a.id)?.walking);
          if (chatting.length > 0 && Math.random() < 0.7) {
            const who = chatting[Math.floor(Math.random() * chatting.length)]!;
            const glyph = CHAT_GLYPHS[Math.floor(Math.random() * CHAT_GLYPHS.length)]!;
            setChatGlyphs({ [who.id]: glyph });
            setTimeout(() => {
              if (!disposed) setChatGlyphs({});
            }, 1800);
          }
        }

        // Name tags, bubbles and reactions: projected HTML overlays with collision resolution
        const w = container.clientWidth || 320;
        const h = container.clientHeight || 240;

        const rawLabels = currentActors.map((actor) => {
          const rig = charRigs.get(actor.id);
          const label = actor.label.slice(0, LABEL_MAX_CHARS);
          const projPos = new THREE.Vector3(
            rig ? rig.pos.x : 0,
            rig ? (rig.person ? rig.person.headTop + 0.15 : rig.model!.headY * RIG_SCALE + 0.45) : 1.2,
            rig ? rig.pos.z : 0
          );
          const screen = presenter.project(projPos, camera, projectedPoint);
          const screenX = Math.round(screen.x);
          const screenY = Math.round(screen.y);
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

        const rawById = new Map(rawLabels.map((l) => [l.id, l] as const));
        currentActors.forEach((actor) => {
          const overlayEl = overlayMapRef.current.get(actor.id);
          const r = resolvedMap.get(actor.id);
          if (overlayEl && r) {
            // A person the zoomed or moved camera leaves out of frame has no tag pinned to the edge
            const raw = rawById.get(actor.id);
            const offscreen = !raw || raw.x < 0 || raw.x > w || raw.y < 0 || raw.y > h;
            overlayEl.style.visibility = offscreen ? "hidden" : "visible";
            const isFlipped = r.y < 110;
            overlayEl.setAttribute("data-flipped", isFlipped ? "true" : "false");
            overlayEl.setAttribute("data-collapsed", r.collapsed ? "true" : "false");
            overlayEl.style.transform = `translate3d(${r.x}px, ${r.y}px, 0)`;
          }
        });

        for (const [id, el] of staffOverlayRef.current) {
          const rig = charRigs.get(id);
          if (!rig) continue;
          const p = presenter.project(new THREE.Vector3(rig.pos.x, rig.person ? rig.person.headTop + 0.2 : rig.model!.headY * RIG_SCALE + 0.5, rig.pos.z), camera, projectedPoint);
          el.style.transform = `translate3d(${Math.round(p.x)}px, ${Math.round(p.y)}px, 0)`;
        }
        // Council chat glyphs ride on the council members' own overlays
        presenter.render(scene, camera);
        animId = requestAnimationFrame(animate);
      };

      animId = requestAnimationFrame(animate);

      return () => {
        disposed = true;
        if (animId !== null) cancelAnimationFrame(animId);
        if (resizeObserver) resizeObserver.disconnect();
        removeControls();
        for (const rig of charRigs.values()) rig.person?.dispose();
        people?.dispose();
        cars?.dispose();
        for (const item of disposables) {
          try {
            item.dispose();
          } catch {
            // Disposing an already released resource is harmless
          }
        }
        try {
          presenter.dispose();
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
      className="absolute inset-0 select-none overflow-hidden bg-[#acddec] font-mono text-xs touch-none"
      style={{ boxShadow: "inset 0 0 0 2px #0f172a" }}
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
            className="absolute inset-0 h-full w-full block cursor-grab active:cursor-grabbing"
            data-testid="council-office-canvas"
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
                  {!reaction && chatGlyphs[actor.id] ? (
                    <div className="mb-1 bg-white px-1.5 py-0.5 text-xs font-mono font-bold text-slate-900 border border-slate-900" style={{ boxShadow: "1px 1px 0 #0f172a" }}>
                      {chatGlyphs[actor.id]}
                    </div>
                  ) : null}
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
            {staffIds.map((id) => (
              <div
                key={id}
                ref={(el) => {
                  if (el) staffOverlayRef.current.set(id, el);
                  else staffOverlayRef.current.delete(id);
                }}
                className="absolute left-0 top-0 -translate-x-1/2 -translate-y-full"
                style={{ transform: "translate3d(-9999px, -9999px, 0)" }}
              >
                {chatGlyphs[id] ? (
                  <div className="bg-white px-1.5 py-0.5 text-xs font-mono font-bold text-slate-900 border border-slate-900" style={{ boxShadow: "1px 1px 0 #0f172a" }}>
                    {chatGlyphs[id]}
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          {/* Camera: a hint and a reset once the view has moved */}
          <div className="pointer-events-none absolute bottom-2 left-2 z-10 flex items-center gap-2 text-[10px] font-mono text-slate-800">
            {viewMoved ? (
              <button
                type="button"
                className="pointer-events-auto border-2 border-slate-900 bg-amber-200 px-2 py-0.5 font-bold"
                style={{ boxShadow: "2px 2px 0 #0f172a" }}
                onClick={() => {
                  Object.assign(viewTargetRef.current, VIEW_DEFAULT);
                  setViewMoved(false);
                }}
                data-testid="council-camera-reset"
              >
                ⟲ {t("councilCameraReset")}
              </button>
            ) : null}
            <span className="bg-white/70 px-1.5 py-0.5">{t("councilCameraHint")}</span>
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
