import type * as ThreeNS from "three";

type Three = typeof import("three");

/**
 * 3D pixel-art pipeline (t3ssel8r style). The scene is drawn into a small render target with a 2:1
 * dimetric orthographic camera, then a post pass reads colour and depth from it, adds outlines and
 * upscales to the canvas with nearest sampling, so every render pixel is a crisp block.
 */

/** Per-box edge line meshes (the old outline). Off: the post pass outlines silhouettes instead. */
export const MESH_EDGE_LINES = false;
/** Render pixels per world unit along the screen x axis, fixed for every zoom level. */
export const PIXELS_PER_UNIT = 16;
/** Allowed CSS pixels per render pixel (zoom steps). */
export const ZOOM_SCALES = [1, 2, 3, 4, 6, 8] as const;
/** 2:1 dimetric: floor lines climb one pixel per two across when sin(pitch) = 0.5. */
export const CAMERA_PITCH = Math.PI / 6;
/** Azimuth of the default view; the other three are 90° apart. */
export const CAMERA_YAW = Math.PI / 4;
export const CAMERA_DISTANCE = 60;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 500;
/** Top of the always-visible wall stubs; front walls are cut here. */
export const WALL_STUB_HEIGHT = 0.35;

/** Silhouette outline: own colour at 0.45 in sRGB, which is this factor on linear values. */
const OUTLINE_SHADE = 0.18;
/** Depth step (world units along the view) that counts as a silhouette. */
const SILHOUETTE_DEPTH = 0.14;
/** Colour lift of the lit rim on convex edges. */
const RIM_LIFT = 0.28;

/** Camera yaw snapped to the nearest of the four views. */
export function snapYaw(yaw: number): number {
  return CAMERA_YAW + Math.round((yaw - CAMERA_YAW) / (Math.PI / 2)) * (Math.PI / 2);
}

/** Sun direction in the camera frame: from above and the left, so top, left and right faces get three tones. */
export function sunPosition(yaw: number, out: ThreeNS.Vector3): ThreeNS.Vector3 {
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  return out.set((fx - rx) * 0.8, 1.6, (fz - rz) * 0.8).multiplyScalar(10);
}

export type PixelStyle = {
  gradient: ThreeNS.DataTexture;
  /** Flags (north, south, west, east): the wall is in front of the camera and cut down to its stub. */
  wallCut: { value: ThreeNS.Vector4 };
  /** Toon material with the 3-tone gradient and the front-wall cut. */
  toon: (params: ThreeNS.MeshToonMaterialParameters) => ThreeNS.MeshToonMaterial;
  /** Flags the walls that stand between the camera and the room for this yaw. */
  setFrontWalls: (yaw: number) => void;
};

const styles = new WeakMap<object, PixelStyle>();

/** Shared toon gradient and wall-cut uniform for one three module. */
export function getPixelStyle(THREE: Three): PixelStyle {
  const cached = styles.get(THREE);
  if (cached) return cached;

  // Gradient over dot(normal, light) in [-1, 1]: shadow side, side, lit top
  const steps = 24;
  const data = new Uint8Array(steps);
  for (let i = 0; i < steps; i++) {
    const dot = -1 + ((i + 0.5) * 2) / steps;
    data[i] = dot < 0.2 ? 0 : dot < 0.7 ? 150 : 255;
  }
  const gradient = new THREE.DataTexture(data, steps, 1, THREE.RedFormat, THREE.UnsignedByteType);
  gradient.minFilter = THREE.NearestFilter;
  gradient.magFilter = THREE.NearestFilter;
  gradient.generateMipmaps = false;
  gradient.needsUpdate = true;

  const wallCut = { value: new THREE.Vector4(0, 0, 0, 0) };
  const cutTest = (
    "(vCutPos.y > " + (WALL_STUB_HEIGHT + 0.001).toFixed(3) + " && (" +
    "(uWallCut.x > 0.5 && vCutPos.z < -9.7 && vCutPos.z > -10.5) || (uWallCut.y > 0.5 && vCutPos.z > 9.7 && vCutPos.z < 10.5) || " +
    "(uWallCut.z > 0.5 && vCutPos.x < -19.7 && vCutPos.x > -20.5) || (uWallCut.w > 0.5 && vCutPos.x > 19.7 && vCutPos.x < 20.5)))"
  );
  const onBeforeCompile = (shader: ThreeNS.WebGLProgramParametersWithUniforms) => {
    shader.uniforms.uWallCut = wallCut;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vCutPos;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvCutPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vCutPos;\nuniform vec4 uWallCut;")
      .replace("void main() {", "void main() {\n  if " + cutTest + " discard;");
  };

  const style: PixelStyle = {
    gradient,
    wallCut,
    toon(params) {
      const transparent = params.transparent === true;
      const mat = new THREE.MeshToonMaterial({ ...params, gradientMap: gradient, depthWrite: !transparent });
      mat.onBeforeCompile = onBeforeCompile;
      return mat;
    },
    setFrontWalls(yaw) {
      wallCut.value.set(Math.cos(yaw) < 0 ? 1 : 0, Math.cos(yaw) > 0 ? 1 : 0, Math.sin(yaw) < 0 ? 1 : 0, Math.sin(yaw) > 0 ? 1 : 0);
    },
  };
  styles.set(THREE, style);
  return style;
}

const VERTEX = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 uDev;
uniform vec2 uRt;
uniform float uScale;
uniform vec2 uShift;
uniform float uNear;
uniform float uFar;
uniform float uTopSlope;
uniform float uSilhouette;
uniform float uShade;
uniform float uRim;

float depthAt(ivec2 p) {
  p = clamp(p, ivec2(0), ivec2(uRt) - 1);
  return uNear + texelFetch(tDepth, p, 0).r * (uFar - uNear);
}

// A face parallel to the floor: flat along the screen x axis, one fixed depth step per pixel along y
bool topFace(float dc, float dl, float dr, float du, float dd) {
  float e = uTopSlope * 0.35;
  bool flatX = abs(dr - dc) < e || abs(dc - dl) < e;
  bool slopeY = abs((du - dc) - uTopSlope) < e || abs((dc - dd) - uTopSlope) < e;
  return flatX && slopeY;
}

void main() {
  vec2 rtPos = (gl_FragCoord.xy - uDev * 0.5 - uShift) / uScale + uRt * 0.5;
  ivec2 p = ivec2(floor(rtPos));
  vec3 c = texelFetch(tColor, clamp(p, ivec2(0), ivec2(uRt) - 1), 0).rgb;

  float dc = depthAt(p);
  float dl = depthAt(p + ivec2(-1, 0));
  float dr = depthAt(p + ivec2(1, 0));
  float du = depthAt(p + ivec2(0, 1));
  float dd = depthAt(p + ivec2(0, -1));

  float behind = max(max(dl - dc, dr - dc), max(du - dc, dd - dc));
  if (behind > uSilhouette) {
    c *= uShade;
  } else if (topFace(dc, dl, dr, du, dd)) {
    // Lit rim: the lowest row of a top face, where it turns down into a side face
    float dbl = depthAt(p + ivec2(-1, -1));
    float dbr = depthAt(p + ivec2(1, -1));
    float ddd = depthAt(p + ivec2(0, -2));
    bool belowTop = topFace(dd, dbl, dbr, dc, ddd);
    if (!belowTop && abs(dd - dc) < uSilhouette) c = c * (1.0 + uRim) + uRim * 0.15;
  }

  gl_FragColor = linearToOutputTexel(vec4(c, 1.0));
}
`;

/** View state the camera is placed from. */
export type PixelView = { yaw: number; pitch: number; tx: number; tz: number };

/**
 * Low-res render target plus the nearest-upscale post pass. One render pixel is `scale` CSS pixels
 * (the zoom step); the camera moves in whole render pixels and the leftover sub-pixel shift is
 * applied when presenting, so panning stays smooth without shimmer.
 */
export class PixelPresenter {
  private readonly THREE: Three;
  private readonly renderer: ThreeNS.WebGLRenderer;
  private target: ThreeNS.WebGLRenderTarget;
  private readonly material: ThreeNS.ShaderMaterial;
  private readonly mesh: ThreeNS.Mesh;
  private readonly quadScene: ThreeNS.Scene;
  private readonly quadCamera: ThreeNS.OrthographicCamera;
  private readonly geometry: ThreeNS.BufferGeometry;
  private readonly size: ThreeNS.Vector2;
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private devW = 1;
  private devH = 1;
  private deviceScale = 1;
  private rtW = 1;
  private rtH = 1;
  private shiftX = 0;
  private shiftY = 0;
  /** CSS pixels per render pixel (the zoom step). */
  scale = 2;

  constructor(THREE: Three, renderer: ThreeNS.WebGLRenderer) {
    this.THREE = THREE;
    this.renderer = renderer;
    this.size = new THREE.Vector2();
    this.target = this.makeTarget(2, 2);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tColor: { value: null },
        tDepth: { value: null },
        uDev: { value: new THREE.Vector2(1, 1) },
        uRt: { value: new THREE.Vector2(1, 1) },
        uScale: { value: 1 },
        uShift: { value: new THREE.Vector2(0, 0) },
        uNear: { value: CAMERA_NEAR },
        uFar: { value: CAMERA_FAR },
        uTopSlope: { value: 1 / Math.tan(CAMERA_PITCH) / PIXELS_PER_UNIT },
        uSilhouette: { value: SILHOUETTE_DEPTH },
        uShade: { value: OUTLINE_SHADE },
        uRim: { value: RIM_LIFT },
      },
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.mesh);
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  private makeTarget(w: number, h: number): ThreeNS.WebGLRenderTarget {
    const THREE = this.THREE;
    const gl = this.renderer.extensions;
    const floatOk = gl.has("EXT_color_buffer_float") || gl.has("EXT_color_buffer_half_float");
    const depthTexture = new THREE.DepthTexture(w, h);
    depthTexture.minFilter = THREE.NearestFilter;
    depthTexture.magFilter = THREE.NearestFilter;
    const target = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      type: floatOk ? THREE.HalfFloatType : THREE.UnsignedByteType,
      depthBuffer: true,
      depthTexture,
      generateMipmaps: false,
      samples: 0,
    });
    return target;
  }

  /** Canvas size in CSS pixels; `dpr` is the device pixel ratio. */
  resize(cssW: number, cssH: number, dpr: number): void {
    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = dpr;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(cssW, cssH, false);
    this.renderer.getDrawingBufferSize(this.size);
    this.devW = this.size.x;
    this.devH = this.size.y;
    this.applyScale();
  }

  /** Zoom step: CSS pixels per render pixel. */
  setScale(scale: number): void {
    if (scale === this.scale && this.rtW > 1) return;
    this.scale = scale;
    this.applyScale();
  }

  private applyScale(): void {
    this.deviceScale = Math.max(1, Math.round(this.scale * this.dpr));
    const w = Math.ceil(this.devW / this.deviceScale) + 2;
    const h = Math.ceil(this.devH / this.deviceScale) + 2;
    if (w !== this.rtW || h !== this.rtH) {
      this.rtW = w;
      this.rtH = h;
      this.target.dispose();
      this.target.depthTexture?.dispose();
      this.target = this.makeTarget(w, h);
    }
  }

  /** World units a render pixel spans. */
  get unit(): number {
    return 1 / PIXELS_PER_UNIT;
  }

  /**
   * Places the camera for the view, snapped to the render-pixel grid in camera space, and sizes the
   * frustum to the render target. `centerY` lifts the frustum (view units) as the old fit did.
   */
  placeCamera(camera: ThreeNS.OrthographicCamera, view: PixelView, centerY: number): void {
    const R = PIXELS_PER_UNIT;
    const sy = Math.sin(view.yaw);
    const cy = Math.cos(view.yaw);
    const sp = Math.sin(view.pitch);
    const cp = Math.cos(view.pitch);
    // Camera right (rx, 0, rz) and up (ux, uy, uz)
    const rx = cy;
    const rz = -sy;
    const ux = -sy * sp;
    const uy = cp;
    const uz = -cy * sp;
    const a = view.tx * rx + view.tz * rz;
    const b = view.tx * ux + view.tz * uz;
    const sa = Math.round(a * R) / R;
    const sb = Math.round(b * R) / R;
    const lx = view.tx + (sa - a) * rx + (sb - b) * ux;
    const ly = (sb - b) * uy;
    const lz = view.tz + (sa - a) * rz + (sb - b) * uz;
    camera.position.set(lx + CAMERA_DISTANCE * sy * cp, ly + CAMERA_DISTANCE * sp, lz + CAMERA_DISTANCE * cy * cp);
    camera.lookAt(lx, ly, lz);
    // Rendering is shifted by (sa - a) in camera space; present the opposite sub-pixel offset
    this.shiftX = Math.round((a - sa) * R * -this.deviceScale);
    this.shiftY = Math.round((b - sb) * R * -this.deviceScale);

    const halfW = this.rtW / (2 * R);
    const halfH = this.rtH / (2 * R);
    const lift = Math.round(centerY * R) / R;
    camera.left = -halfW;
    camera.right = halfW;
    camera.top = halfH + lift;
    camera.bottom = -halfH + lift;
    camera.near = CAMERA_NEAR;
    camera.far = CAMERA_FAR;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  }

  /** Draws the scene at low resolution, then the outlined nearest upscale onto the canvas. */
  render(scene: ThreeNS.Scene, camera: ThreeNS.Camera): void {
    const renderer = this.renderer;
    renderer.setRenderTarget(this.target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);

    const u = this.material.uniforms;
    u.tColor!.value = this.target.texture;
    u.tDepth!.value = this.target.depthTexture;
    (u.uDev!.value as ThreeNS.Vector2).set(this.devW, this.devH);
    (u.uRt!.value as ThreeNS.Vector2).set(this.rtW, this.rtH);
    u.uScale!.value = this.deviceScale;
    (u.uShift!.value as ThreeNS.Vector2).set(this.shiftX, this.shiftY);
    renderer.render(this.quadScene, this.quadCamera);
  }

  /** Projects a world point to CSS pixels inside the canvas, matching what `render` presents. */
  project(point: ThreeNS.Vector3, camera: ThreeNS.Camera, out: { x: number; y: number }): { x: number; y: number } {
    const p = point.clone().project(camera);
    const devX = this.devW / 2 + this.shiftX + (((p.x + 1) / 2) * this.rtW - this.rtW / 2) * this.deviceScale;
    const devYUp = this.devH / 2 + this.shiftY + (((p.y + 1) / 2) * this.rtH - this.rtH / 2) * this.deviceScale;
    out.x = devX / this.dpr;
    out.y = this.cssH - devYUp / this.dpr;
    return out;
  }

  dispose(): void {
    this.target.dispose();
    this.target.depthTexture?.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
