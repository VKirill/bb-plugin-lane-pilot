import type * as ThreeNS from "three";
import { CAMERA_PITCH, CAMERA_YAW, PIXELS_PER_UNIT, ZOOM_SCALES, getPixelStyle, type PixelPresenter } from "./pixel";

type Three = typeof ThreeNS;

/**
 * Camera: 2:1 dimetric (azimuth 45°, pitch 30°), four views 90° apart, fixed pitch. `zoom` is the
 * CSS pixels per render pixel (one of ZOOM_SCALES); 0 means the largest step that fits the scene.
 */
export type CameraView = { yaw: number; pitch: number; zoom: number; tx: number; tz: number };

export const CAMERA_VIEW_DEFAULT: Readonly<CameraView> = { yaw: CAMERA_YAW, pitch: CAMERA_PITCH, zoom: 0, tx: 0, tz: 0 };

/** A drag this long (CSS px) turns the scene by one view. */
export const TURN_DRAG_PX = 50;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export type PixelCameraOptions = {
  THREE: Three;
  canvas: HTMLCanvasElement;
  presenter: PixelPresenter;
  camera: ThreeNS.OrthographicCamera;
  /** The target the controls move; pass the same object again after a remount to keep the view. Default: a copy of the default view. */
  target?: CameraView;
  /** The view point may move this far from the origin along x and z. */
  panLimit: { x: number; z: number };
  /** Skips the easing (`prefers-reduced-motion`). */
  reducedMotion?: boolean;
  /** Called after every placement of the camera (sun position, label projection …). */
  onApply?: (view: Readonly<CameraView>) => void;
  /** The user moved the view (drag, wheel, pinch). */
  onMoved?: () => void;
  /** A double click put the view back to the default. */
  onReset?: () => void;
};

/**
 * Orbit controls for the pixel camera: drag turns by whole views, right/shift-drag or two fingers move,
 * wheel or pinch steps the integer zoom, double-click resets. The shown view eases towards the target
 * (frame-rate independent); `update` runs once per frame.
 */
export class PixelCameraControls {
  /** The view being shown: eases towards `target`. */
  readonly view: CameraView;
  /** Where the controls want the view to be. */
  readonly target: CameraView;
  private readonly o: PixelCameraOptions;
  private readonly pixelStyle: ReturnType<typeof getPixelStyle>;
  private centerY = 1.3;
  /** The zoom step that fits the scene (CSS px per render pixel). */
  private autoScale: number = ZOOM_SCALES[1];
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinchDistance = 0;
  private turnDrag = 0;
  private wheelDelta = 0;
  private attached = false;

  constructor(options: PixelCameraOptions) {
    this.o = options;
    this.pixelStyle = getPixelStyle(options.THREE);
    this.target = options.target ?? { ...CAMERA_VIEW_DEFAULT };
    this.view = { ...this.target };
  }

  private scaleOf(zoom: number): number {
    return zoom > 0 ? zoom : this.autoScale;
  }

  /** Places the camera for the shown view. */
  apply(): void {
    this.o.presenter.setScale(this.scaleOf(this.view.zoom));
    this.o.presenter.placeCamera(this.o.camera, this.view, this.centerY);
    this.pixelStyle.setFrontWalls(this.view.yaw);
    this.o.onApply?.(this.view);
  }

  /**
   * Sets the framing after a resize: `viewHeight` is the world height the scene wants on screen, `centerY` lifts the
   * frustum, `height` is the canvas height in CSS px. The default zoom is the largest whole-pixel scale at which the
   * scene nearly fits; up to 20 % may run past the edges, otherwise a narrow panel gets a tiny 1× scene.
   */
  fit(viewHeight: number, centerY: number, height: number): void {
    this.centerY = centerY;
    this.autoScale = [...ZOOM_SCALES].reverse().find((step) => viewHeight * PIXELS_PER_UNIT * step <= height * 1.2) ?? ZOOM_SCALES[0];
    this.apply();
  }

  /** Puts the target back to the default view. */
  reset(): void {
    Object.assign(this.target, CAMERA_VIEW_DEFAULT);
  }

  /** One zoom step in or out along ZOOM_SCALES from the current scale. */
  private stepZoom(direction: number): void {
    const now = this.scaleOf(this.target.zoom);
    const index = ZOOM_SCALES.findIndex((step) => step >= now);
    const from = index < 0 ? ZOOM_SCALES.length - 1 : index;
    this.target.zoom = ZOOM_SCALES[clamp(from + direction, 0, ZOOM_SCALES.length - 1)]!;
  }

  private panBy(dxPx: number, dyPx: number): void {
    const target = this.target;
    const unitsPerPx = 1 / (PIXELS_PER_UNIT * this.scaleOf(target.zoom));
    const right = { x: Math.cos(target.yaw), z: -Math.sin(target.yaw) };
    const back = { x: Math.sin(target.yaw), z: Math.cos(target.yaw) };
    const lift = 1 / Math.max(0.3, Math.sin(target.pitch));
    target.tx = clamp(target.tx - (dxPx * right.x + dyPx * -back.x * lift) * unitsPerPx, -this.o.panLimit.x, this.o.panLimit.x);
    target.tz = clamp(target.tz - (dxPx * right.z + dyPx * -back.z * lift) * unitsPerPx, -this.o.panLimit.z, this.o.panLimit.z);
  }

  private readonly onPointerDown = (e: PointerEvent) => {
    this.o.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.turnDrag = 0;
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinchDistance = Math.hypot(a!.x - b!.x, a!.y - b!.y);
    }
  };

  private readonly onPointerMove = (e: PointerEvent) => {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      if (this.pinchDistance > 0 && (dist / this.pinchDistance > 1.25 || dist / this.pinchDistance < 0.8)) {
        this.stepZoom(dist > this.pinchDistance ? 1 : -1);
        this.pinchDistance = dist;
      }
      if (this.pinchDistance === 0) this.pinchDistance = dist;
      this.panBy(dx / 2, dy / 2);
    } else if (e.buttons === 2 || e.shiftKey) {
      this.panBy(dx, dy);
    } else {
      // Dragging turns the scene by whole views: each TURN_DRAG_PX of drag is a quarter turn
      this.turnDrag += dx;
      if (Math.abs(this.turnDrag) >= TURN_DRAG_PX) {
        this.target.yaw -= Math.sign(this.turnDrag) * (Math.PI / 2);
        this.turnDrag = 0;
      }
    }
    this.o.onMoved?.();
  };

  private readonly onPointerUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    this.pinchDistance = 0;
  };

  private readonly onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.wheelDelta += e.deltaY;
    if (Math.abs(this.wheelDelta) >= 40) {
      this.stepZoom(this.wheelDelta < 0 ? 1 : -1);
      this.wheelDelta = 0;
    }
    this.o.onMoved?.();
  };

  private readonly onDoubleClick = () => {
    this.reset();
    this.o.onReset?.();
  };

  private readonly onContextMenu = (e: Event) => e.preventDefault();

  /** Starts listening on the canvas. */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    const canvas = this.o.canvas;
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("dblclick", this.onDoubleClick);
    canvas.addEventListener("contextmenu", this.onContextMenu);
  }

  /** Stops listening. */
  dispose(): void {
    if (!this.attached) return;
    this.attached = false;
    const canvas = this.o.canvas;
    canvas.removeEventListener("pointerdown", this.onPointerDown);
    canvas.removeEventListener("pointermove", this.onPointerMove);
    canvas.removeEventListener("pointerup", this.onPointerUp);
    canvas.removeEventListener("pointercancel", this.onPointerUp);
    canvas.removeEventListener("wheel", this.onWheel);
    canvas.removeEventListener("dblclick", this.onDoubleClick);
    canvas.removeEventListener("contextmenu", this.onContextMenu);
    this.pointers.clear();
  }

  /** Eases the shown view towards the target and places the camera when it moved. Call once per frame. */
  update(dt: number): void {
    const view = this.view;
    const goal = this.target;
    const ease = this.o.reducedMotion ? 1 : 1 - Math.exp(-12 * dt);
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
      this.apply();
    }
  }
}
