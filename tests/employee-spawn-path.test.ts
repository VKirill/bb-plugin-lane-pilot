import { describe, expect, it } from "vitest";
import { EMPLOYEES, employeeView } from "../src/rooms/native-agent/employee-manifest";
import { placeEmployeeOn, AFFINITY_HOSTS } from "../src/rooms/native-agent/employee-place";
import { roleRowOf, roleRow } from "@lane-pilot/models";
import { laneSessionOverlayPrompt } from "../src/rooms/native-agent/native-agent-overlay";
import { roleSpec } from "../src/rooms/workflow/server/workflow-agent";
import { compileEffectiveMainAgent } from "../src/rooms/native-agent/agent-profile";
import type { MachineAffinity } from "../src/rooms/native-agent/employee-manifest";

// bb SDK stub: every host answers a home directory, mkdir always succeeds.
const bbStub = () => ({
  sdk: {
    hosts: { directory: async ({ hostId }: { hostId: string }) => ({ directory: `/home/${hostId}` }) },
    files: { mkdir: async () => ({}) },
  },
});

const AFFINITY_FOR = (a: MachineAffinity) => a as Exclude<MachineAffinity, "any">;

describe("employee spawn path: host + model + catalog sections per employee", () => {
  for (const [role, manifest] of Object.entries(EMPLOYEES)) {
    it(`${role}`, async () => {
      // 1. Role resolution treats it as a specialist (real roleSpec).
      const spec = roleSpec(`specialist:${role}`);
      expect(spec.specialist).toBe(role);

      // 2. Placement lands on the machine the profile's affinity names (real placeEmployeeOn).
      const place = await placeEmployeeOn(bbStub() as never, role, []);
      if (manifest.machineAffinity === "any") {
        expect(place.mode).toBe("inherit");
      } else {
        expect(place.mode).toBe("folder");
        expect((place as { hostId: string }).hostId).toBe(AFFINITY_HOSTS[AFFINITY_FOR(manifest.machineAffinity)]);
      }

      // 3. The role table has a real row (model + effort) for this role (real roleRow).
      const row = roleRow(`specialist:${role}`);
      expect(row.id).toBe(roleRowOf(`specialist:${role}`));
      expect(row.default.model).toBeTruthy();

      // 4. The session profile names the employee's catalog sections (real laneSessionOverlayPrompt).
      const prompt = laneSessionOverlayPrompt(role);
      for (const section of manifest.skillSections) expect(prompt, section).toContain(section);

      // 5. The bundled profile carries the core skills.
      const profile = compileEffectiveMainAgent(role, undefined);
      for (const skill of manifest.coreSkills) expect(profile.skills ?? []).toContain(skill);
    });
  }
});
