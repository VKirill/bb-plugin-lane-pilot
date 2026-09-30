import { expect, it } from "vitest";
import { compileMainAgentProfile } from "../src/agent-profile";
import { sessionOverrideAgentsJson } from "../src/native-agent-definition";

it("emits --agents JSON from the plugin profile, including unedited stock", () => {
  const compiled = compileMainAgentProfile("dev-orchestrator");
  expect(JSON.parse(sessionOverrideAgentsJson({ agentId: "dev-orchestrator", edited: false, compiled })!)).toEqual({
    "dev-orchestrator": {
      description: compiled.description,
      prompt: compiled.prompt,
      ...(compiled.tools ? { tools: compiled.tools } : {}),
      ...(compiled.skills ? { skills: compiled.skills } : {}),
      ...(compiled.mcpServers ? { mcpServers: compiled.mcpServers } : {}),
    },
  });
});

it("forwards every CLI AgentDefinition resource on an edited profile", () => {
  const compiled = compileMainAgentProfile("dev-orchestrator", {
    description: "Edited coordinator",
    prompt: "Edited prompt",
    tools: ["Read"],
    disallowedTools: ["Bash"],
    skills: ["lane-contract"],
    mcpServers: ["gitnexus"],
  });
  expect(JSON.parse(sessionOverrideAgentsJson({
    agentId: "lane-stack:dev-orchestrator",
    edited: true,
    compiled,
  })!)).toEqual({
    "dev-orchestrator": {
      description: "Edited coordinator",
      prompt: "Edited prompt",
      tools: ["Read"],
      disallowedTools: ["Bash"],
      skills: ["lane-contract"],
      mcpServers: ["gitnexus"],
    },
  });
});

it("rejects an unsupported resource change instead of dropping it", () => {
  const compiled = compileMainAgentProfile("dev-orchestrator", {
    description: "Edited coordinator",
    prompt: "Edited prompt",
  });
  expect(() => sessionOverrideAgentsJson({
    agentId: "dev-orchestrator",
    edited: true,
    compiled,
    extraFields: { unknownResource: ["x"] },
  })).toThrow(/unsupported_agent_definition_field:unknownResource/);
});
