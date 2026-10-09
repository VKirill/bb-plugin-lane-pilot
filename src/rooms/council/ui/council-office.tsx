import { useEffect, useRef, useState } from "react";
import { t } from "@lane-pilot/i18n";
import {
  deriveOfficeActors,
  nextWanderTarget,
  seatColor,
  type CouncilDetailLike,
  type OfficeActor,
} from "./office-behaviour";

export type CouncilOfficeProps = {
  detail: CouncilDetailLike;
  cursor: number | null;
  highlightSeatId?: string | null;
  onSelectSpeaker?: (seatId: string) => void;
};

// Known spots in isometric office coordinates (x, z)
const WANDER_SPOTS: Record<string, { x: number; z: number }> = {
  desk1: { x: -3.5, z: -2.5 },
  desk2: { x: -3.5, z: 2.5 },
  desk3: { x: 3.5, z: -2.5 },
  coffee: { x: 4.2, z: 4.0 },
  bookshelf: { x: -4.2, z: -4.2 },
  window: { x: -4.0, z: 0 },
  plant1: { x: 4.0, z: -4.2 },
  plant2: { x: -4.2, z: 4.2 },
};

const TABLE_SEATS = [
  { x: -1.8, z: 0, angle: Math.PI / 2 },
  { x: 1.8, z: 0, angle: -Math.PI / 2 },
  { x: -0.9, z: -1.4, angle: 0 },
  { x: 0.9, z: -1.4, angle: 0 },
  { x: -0.9, z: 1.4, angle: Math.PI },
  { x: 0.9, z: 1.4, angle: Math.PI },
  { x: 0, z: -1.5, angle: 0 },
  { x: 0, z: 1.5, angle: Math.PI },
];

export function CouncilOffice({
  detail,
  cursor,
  highlightSeatId,
  onSelectSpeaker,
}: CouncilOfficeProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [actors, setActors] = useState<OfficeActor[]>(() =>
    deriveOfficeActors(detail, cursor, Date.now())
  );
  const [now, setNow] = useState(() => Date.now());
  const [hasWebGL, setHasWebGL] = useState<boolean | null>(null);
  const [screenCoords, setScreenCoords] = useState<
    Record<string, { left: number; top: number }>
  >({});

  // Periodic tick for live idle/wandering checks
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setActors(deriveOfficeActors(detail, cursor, now));
  }, [detail, cursor, now]);

  useEffect(() => {
    let disposed = false;
    let animId: number | null = null;
    let resizeObserver: ResizeObserver | null = null;

    async function initThree() {
      // Feature detect WebGL
      try {
        if (typeof window === "undefined" || typeof document === "undefined") {
          setHasWebGL(false);
          return;
        }
        // Check if WebGLRenderingContext exists and is supported
        if (typeof (window as unknown as { WebGLRenderingContext?: unknown }).WebGLRenderingContext === "undefined") {
          setHasWebGL(false);
          return;
        }
        const testCanvas = document.createElement("canvas");
        // In jsdom without canvas package, getContext prints "Not implemented" or throws
        let gl: unknown = null;
        try {
          gl =
            testCanvas.getContext("webgl") ||
            testCanvas.getContext("experimental-webgl");
        } catch {
          gl = null;
        }
        if (!gl) {
          setHasWebGL(false);
          return;
        }
      } catch {
        setHasWebGL(false);
        return;
      }

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

      setHasWebGL(true);

      const scene = new THREE.Scene();

      // Ambient + Directional lighting with pixel/flat look
      const ambientLight = new THREE.AmbientLight(0xffffff, 0.85);
      scene.add(ambientLight);

      const dirLight = new THREE.DirectionalLight(0xfff5ea, 0.65);
      dirLight.position.set(10, 15, 10);
      scene.add(dirLight);

      // Isometric camera setup
      const aspect = container.clientWidth / (container.clientHeight || 1);
      const viewSize = 13;
      const camera = new THREE.OrthographicCamera(
        (-viewSize * aspect) / 2,
        (viewSize * aspect) / 2,
        viewSize / 2,
        -viewSize / 2,
        0.1,
        1000
      );

      // Isometric view: ~35.264° elevation, 45° azimuth
      camera.position.set(12, 14, 12);
      camera.lookAt(0, 0, 0);

      const disposables: Array<{ dispose: () => void }> = [];

      // Materials & Geometries
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

      // --- Room Environment ---
      // Floor: teal tiles
      const floorMat = createMat(0x1e3a47);
      const floorGeom = createBoxGeom(11, 0.4, 11);
      const floor = new THREE.Mesh(floorGeom, floorMat);
      floor.position.set(0, -0.2, 0);
      scene.add(floor);

      // Back-left wall (Cream)
      const wallMat = createMat(0xf4ede2);
      const wallLeftGeom = createBoxGeom(0.4, 5, 11);
      const wallLeft = new THREE.Mesh(wallLeftGeom, wallMat);
      wallLeft.position.set(-5.3, 2.3, 0);
      scene.add(wallLeft);

      // Back-right wall (Cream)
      const wallRightGeom = createBoxGeom(11, 5, 0.4);
      const wallRight = new THREE.Mesh(wallRightGeom, wallMat);
      wallRight.position.set(0, 2.3, -5.3);
      scene.add(wallRight);

      // Window on back-left wall
      const windowMat = createMat(0x7dd3fc); // bright sky blue
      const windowFrameMat = createMat(0x334155);
      const winGeom = createBoxGeom(0.5, 2.2, 3);
      const winMesh = new THREE.Mesh(winGeom, windowMat);
      winMesh.position.set(-5.28, 2.8, 0);
      scene.add(winMesh);

      // Door on back-right wall
      const doorMat = createMat(0x854d0e);
      const doorGeom = createBoxGeom(1.6, 3.4, 0.5);
      const doorMesh = new THREE.Mesh(doorGeom, doorMat);
      doorMesh.position.set(3, 1.5, -5.28);
      scene.add(doorMesh);

      // Bookshelf
      const shelfMat = createMat(0x78350f);
      const shelfGeom = createBoxGeom(1.8, 3.2, 0.8);
      const shelf = new THREE.Mesh(shelfGeom, shelfMat);
      shelf.position.set(-4.2, 1.6, -4.2);
      scene.add(shelf);

      // Central Meeting Table (Dark wood)
      const tableMat = createMat(0x9a3412);
      const tableTopGeom = createBoxGeom(4.4, 0.25, 2.2);
      const tableTop = new THREE.Mesh(tableTopGeom, tableMat);
      tableTop.position.set(0, 1.1, 0);
      scene.add(tableTop);

      const tableLegGeom = createBoxGeom(0.3, 1.1, 0.3);
      const tableLegMat = createMat(0x431407);
      const legPositions = [
        [-1.9, 0.55, -0.8],
        [1.9, 0.55, -0.8],
        [-1.9, 0.55, 0.8],
        [1.9, 0.55, 0.8],
      ];
      for (const [lx, ly, lz] of legPositions) {
        const leg = new THREE.Mesh(tableLegGeom, tableLegMat);
        leg.position.set(lx!, ly!, lz!);
        scene.add(leg);
      }

      // Desks & CRT monitors
      const deskMat = createMat(0xd97706);
      const monMat = createMat(0x0f172a);
      const screenGlowMat = createMat(0x38bdf8);
      const deskLocations = [
        { x: -3.6, z: -2.5 },
        { x: -3.6, z: 2.5 },
        { x: 3.6, z: -2.5 },
      ];
      for (const d of deskLocations) {
        const desk = new THREE.Mesh(createBoxGeom(1.6, 1.0, 1.0), deskMat);
        desk.position.set(d.x, 0.5, d.z);
        scene.add(desk);

        const mon = new THREE.Mesh(createBoxGeom(0.5, 0.45, 0.45), monMat);
        mon.position.set(d.x, 1.25, d.z);
        scene.add(mon);

        const scr = new THREE.Mesh(createBoxGeom(0.05, 0.35, 0.35), screenGlowMat);
        scr.position.set(d.x + 0.24, 1.25, d.z);
        scene.add(scr);
      }

      // Coffee corner
      const coffeeCounter = new THREE.Mesh(createBoxGeom(1.4, 1.2, 1.6), createMat(0x475569));
      coffeeCounter.position.set(4.2, 0.6, 3.8);
      scene.add(coffeeCounter);

      const coffeePot = new THREE.Mesh(createBoxGeom(0.4, 0.4, 0.4), createMat(0xef4444));
      coffeePot.position.set(4.2, 1.35, 3.8);
      scene.add(coffeePot);

      // Plants
      const potMat = createMat(0xc2410c);
      const plantMat = createMat(0x15803d);
      const plantLocs = [
        { x: 4.2, z: -4.2 },
        { x: -4.2, z: 4.2 },
      ];
      for (const p of plantLocs) {
        const pot = new THREE.Mesh(createBoxGeom(0.7, 0.7, 0.7), potMat);
        pot.position.set(p.x, 0.35, p.z);
        scene.add(pot);

        const leaf = new THREE.Mesh(createBoxGeom(0.9, 1.1, 0.9), plantMat);
        leaf.position.set(p.x, 1.1, p.z);
        scene.add(leaf);
      }

      // --- Character Mesh Management ---
      type CharObj = {
        group: import("three").Group;
        head: import("three").Mesh;
        body: import("three").Mesh;
        leftLeg: import("three").Mesh;
        rightLeg: import("three").Mesh;
        targetPos: { x: number; z: number };
        currentPos: { x: number; z: number };
        wanderKey: string | null;
        lastWanderTime: number;
      };

      const charObjects = new Map<string, CharObj>();

      const getOrAddChar = (actor: OfficeActor, idx: number): CharObj => {
        let char = charObjects.get(actor.id);
        if (!char) {
          const group = new THREE.Group();
          const charMat = createMat(actor.color);
          const skinMat = createMat(0xfcd34d);
          const pantsMat = createMat(0x1e293b);

          // Head (0.4 x 0.4 x 0.4)
          const head = new THREE.Mesh(createBoxGeom(0.42, 0.42, 0.42), skinMat);
          head.position.y = 1.35;
          group.add(head);

          // Body / Shirt (0.5 x 0.6 x 0.32)
          const body = new THREE.Mesh(createBoxGeom(0.5, 0.55, 0.32), charMat);
          body.position.y = 0.88;
          group.add(body);

          // Legs
          const leftLeg = new THREE.Mesh(createBoxGeom(0.18, 0.6, 0.22), pantsMat);
          leftLeg.position.set(-0.14, 0.3, 0);
          group.add(leftLeg);

          const rightLeg = new THREE.Mesh(createBoxGeom(0.18, 0.6, 0.22), pantsMat);
          rightLeg.position.set(0.14, 0.3, 0);
          group.add(rightLeg);

          const seatPos = TABLE_SEATS[idx % TABLE_SEATS.length]!;
          group.position.set(seatPos.x, 0, seatPos.z);
          scene.add(group);

          char = {
            group,
            head,
            body,
            leftLeg,
            rightLeg,
            targetPos: { x: seatPos.x, z: seatPos.z },
            currentPos: { x: seatPos.x, z: seatPos.z },
            wanderKey: null,
            lastWanderTime: Date.now() + idx * 800,
          };
          charObjects.set(actor.id, char);
        }
        return char;
      };

      // Resize logic with 1/3 low-res pixelation upscale
      const handleResize = () => {
        if (!container || !renderer) return;
        const w = container.clientWidth || 320;
        const h = container.clientHeight || 240;
        const scale = 3; // low-res downscale for authentic pixel look
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

      let tick = 0;

      // Animation Loop
      const animate = () => {
        if (disposed) return;
        tick += 0.05;

        // Update positions & behaviors
        const currentActors = deriveOfficeActors(detail, cursor, Date.now());
        const tempCoords: Record<string, { left: number; top: number }> = {};
        const spotKeys = Object.keys(WANDER_SPOTS);

        currentActors.forEach((actor, idx) => {
          const char = getOrAddChar(actor, idx);
          const seatPos = TABLE_SEATS[idx % TABLE_SEATS.length]!;

          if (actor.activity === "speaking" || actor.activity === "arguing") {
            // Stands directly at the meeting table
            char.targetPos = { x: seatPos.x * 0.85, z: seatPos.z * 0.85 };
            if (!motionReduced) {
              // Little speech bob gesture
              char.body.position.y = 0.88 + Math.sin(tick * 4) * 0.04;
              char.head.position.y = 1.35 + Math.sin(tick * 4) * 0.05;
            }

            // Face previous speaker if arguing, else face center
            if (actor.facing) {
              const opponent = charObjects.get(actor.facing);
              if (opponent) {
                const dx = opponent.currentPos.x - char.currentPos.x;
                const dz = opponent.currentPos.z - char.currentPos.z;
                char.group.rotation.y = Math.atan2(dx, dz);
              }
            } else {
              char.group.rotation.y = Math.atan2(-char.currentPos.x, -char.currentPos.z);
            }
          } else if (actor.activity === "waiting") {
            // Sits at table seat
            char.targetPos = { x: seatPos.x, z: seatPos.z };
            char.group.rotation.y = seatPos.angle;
            char.body.position.y = 0.72; // sitting lower
            char.head.position.y = 1.18;
          } else if (actor.activity === "idle") {
            // Wandering
            if (!motionReduced) {
              const nowMs = Date.now();
              if (nowMs - char.lastWanderTime > 6000 + (idx % 3) * 1500) {
                char.wanderKey = nextWanderTarget(Math.random, char.wanderKey, spotKeys);
                const pt = WANDER_SPOTS[char.wanderKey];
                if (pt) {
                  char.targetPos = { x: pt.x, z: pt.z };
                }
                char.lastWanderTime = nowMs;
              }
            } else {
              char.targetPos = { x: seatPos.x, z: seatPos.z };
            }
          }

          // Move smoothly towards target
          const dx = char.targetPos.x - char.currentPos.x;
          const dz = char.targetPos.z - char.currentPos.z;
          const dist = Math.hypot(dx, dz);

          if (dist > 0.05 && !motionReduced) {
            char.currentPos.x += dx * 0.08;
            char.currentPos.z += dz * 0.08;
            char.group.rotation.y = Math.atan2(dx, dz);
            // Walk leg swing
            char.leftLeg.rotation.x = Math.sin(tick * 5) * 0.5;
            char.rightLeg.rotation.x = -Math.sin(tick * 5) * 0.5;
          } else {
            char.currentPos.x = char.targetPos.x;
            char.currentPos.z = char.targetPos.z;
            char.leftLeg.rotation.x = 0;
            char.rightLeg.rotation.x = 0;
          }
          char.group.position.x = char.currentPos.x;
          char.group.position.z = char.currentPos.z;

          // Project to 2D screen coordinates for HTML labels & speech bubbles
          const projPos = new THREE.Vector3(
            char.currentPos.x,
            char.head.position.y + 0.45,
            char.currentPos.z
          );
          projPos.project(camera);

          const w = container.clientWidth || 320;
          const h = container.clientHeight || 240;
          const screenX = ((projPos.x + 1) * w) / 2;
          const screenY = ((-projPos.y + 1) * h) / 2;

          tempCoords[actor.id] = { left: screenX, top: screenY };
        });

        setScreenCoords(tempCoords);
        renderer.render(scene, camera);
        animId = requestAnimationFrame(animate);
      };

      animate();

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
  }, [detail.id]); // re-init when council id changes

  return (
    <div
      ref={containerRef}
      className="relative flex h-full w-full min-h-[220px] select-none flex-col items-center justify-center overflow-hidden bg-[#182631] text-xs font-mono"
      style={{
        boxShadow: "inset 0 0 0 2px #0f172a",
        imageRendering: "pixelated",
      }}
      data-testid="council-office"
    >
      {hasWebGL === false ? (
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

          {/* Projected HTML Overlays: Name tags and Speech Bubbles */}
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            {actors.map((actor) => {
              const pos = screenCoords[actor.id];
              if (!pos) return null;
              const isHighlighted = highlightSeatId === actor.id;
              const hasBubble = Boolean(actor.bubble);

              return (
                <div
                  key={actor.id}
                  className="pointer-events-auto absolute flex flex-col items-center -translate-x-1/2 -translate-y-full transition-transform duration-75"
                  style={{ left: `${pos.left}px`, top: `${pos.top}px` }}
                  onClick={() => onSelectSpeaker?.(actor.id)}
                >
                  {/* Pixel speech bubble */}
                  {hasBubble ? (
                    <div
                      className="mb-1 max-w-[200px] break-words rounded bg-amber-50 px-2 py-1 text-[11px] font-sans text-slate-900 shadow-[0_2px_0_#0f172a] border border-slate-900 animate-in fade-in"
                      style={{
                        boxShadow: "2px 2px 0 #0f172a",
                        border: "2px solid #0f172a",
                      }}
                    >
                      <div className="font-mono text-[9px] font-bold text-slate-500 uppercase">
                        {actor.label}
                      </div>
                      <div className="line-clamp-3 leading-snug">
                        {actor.bubble}
                      </div>
                    </div>
                  ) : null}

                  {/* Character label tag */}
                  <div
                    className={`px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white border-2 cursor-pointer transition-all ${
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
