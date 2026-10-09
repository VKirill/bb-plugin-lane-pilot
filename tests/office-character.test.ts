import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { applyCharacterPose, buildCharacter, pickCharacterLook, CHARACTER_DIMENSIONS } from "../src/rooms/council/ui/office-character";
import { getOfficePose } from "../src/rooms/council/ui/office-behaviour";

const kit = () => ({ THREE, outlineMaterial: new THREE.LineBasicMaterial(), disposables: [] as Array<{ dispose: () => void }> });

describe("pickCharacterLook", () => {
  it("is deterministic and keeps the seat colour as the main garment", () => {
    expect(pickCharacterLook("n1", "#3b82f6")).toEqual(pickCharacterLook("n1", "#3b82f6"));
    expect(pickCharacterLook("n1", "#3b82f6").shirt).toBe("#3b82f6");
  });

  it("dresses the owner in a dark jacket over his seat-coloured shirt, and the receptionist in a blouse and skirt", () => {
    const owner = pickCharacterLook("owner", "#e11d48");
    expect(owner.jacket).toBeTruthy();
    expect(owner.shirt).toBe("#e11d48");
    expect(pickCharacterLook("staff_reception", "#2c9a8f").outfit).toBe("blouseSkirt");
  });

  it("gives different people different looks", () => {
    const looks = new Set(["n1", "n2", "n3", "s1", "s2", "staff_1", "staff_2", "staff_3"].map((id) => {
      const l = pickCharacterLook(id, "#3b82f6");
      return `${l.hairStyle}|${l.outfit}|${l.skin}|${l.hair}`;
    }));
    expect(looks.size).toBeGreaterThanOrEqual(6);
  });
});

describe("buildCharacter", () => {
  it("stays within the mesh budget and stands about 1.6 tall", () => {
    const k = kit();
    for (const id of ["owner", "staff_reception", "n1", "n2", "staff_3", "skeptic"]) {
      const model = buildCharacter(k, pickCharacterLook(id, "#3b82f6"));
      let meshes = 0;
      model.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes++; });
      expect(meshes).toBeLessThanOrEqual(45);
    }
    expect(CHARACTER_DIMENSIONS.standingHeight).toBeGreaterThan(1.5);
    expect(CHARACTER_DIMENSIONS.standingHeight).toBeLessThan(1.75);
  });

  it("puts the soles on the floor when standing and when seated, and the seat under the pelvis", () => {
    const model = buildCharacter(kit(), pickCharacterLook("n1", "#3b82f6"));
    const sole = () => {
      model.root.updateMatrixWorld(true);
      const v = new THREE.Vector3();
      return Math.min(...model.legs.map((leg) => leg.ankle.getWorldPosition(v).y - 0.07));
    };
    applyCharacterPose(model, getOfficePose("idle", { tick: 1 }), 1);
    expect(sole()).toBeCloseTo(0, 1);
    applyCharacterPose(model, getOfficePose("idle", { tick: 1, sittingProgress: 1, action: "typing" }), 1);
    expect(sole()).toBeCloseTo(0, 1);
    expect(model.pelvis.position.y).toBeLessThan(0.7);
  });

  it("keeps the head height continuous across the sitting blend and shows the mug only for coffee", () => {
    const model = buildCharacter(kit(), pickCharacterLook("n2", "#10b981"));
    let last = Number.NaN;
    for (let i = 0; i <= 10; i++) {
      applyCharacterPose(model, getOfficePose("idle", { tick: 1, sittingProgress: i / 10 }), 1);
      if (!Number.isNaN(last)) expect(Math.abs(model.headY - last)).toBeLessThan(0.1);
      last = model.headY;
    }
    applyCharacterPose(model, getOfficePose("idle", { tick: 1, action: "coffee" }), 1);
    expect(model.mug.visible).toBe(true);
    applyCharacterPose(model, getOfficePose("idle", { tick: 1, action: "chat" }), 1);
    expect(model.mug.visible).toBe(false);
  });
});
