import { describe, expect, it } from "vitest";
import {
  buildCandidateEvidence,
  codeCritiqueSource,
  findingsHash,
  freezeCritiquePolicy,
  MAX_VERIFICATION_IO_BYTES,
  nextRepairAction,
  parseCodeCritique,
  parseCodeCritiqueSettings,
  parseWriterRepairReply,
  persistLedgerFields,
  repairLedgerFromResult,
  sameUnresolvedFindings,
  sameWriterIdentity,
  settingsFromFrozenPolicy,
  sha256Text,
  shouldRequestRepair,
} from "../../src/stages/code-critique";

describe("code critique policy", () => {
  it("stays off unless explicitly enabled", () => {
    expect(parseCodeCritiqueSettings({}).enabled).toBe(false);
    expect(parseCodeCritiqueSettings({ "code_critique.enabled": false }).enabled).toBe(false);
    expect(parseCodeCritiqueSettings({ "code_critique.enabled": true }).enabled).toBe(true);
    expect(parseCodeCritiqueSettings({ "code_critique.max_rounds": 1 }).maxRounds).toBe(1);
  });

  it("marks missing hashes as unknown evidence", () => {
    const evidence = buildCandidateEvidence({
      produced:["note.txt"], hashes:{}, baselineHashes:{},
      verification:[{ command:"test -f note.txt", exitCode:0 }], output:"ok",
      ownsPaths:["note.txt"], neverTouch:[".git/**"], dirtOk:true,
    });
    expect(evidence.truncated).toBe(true);
    expect(evidence.truncateReason).toContain("missing_hash");
  });

  it("requests one repair for a blocking finding and stops on a repeat", () => {
    const settings = parseCodeCritiqueSettings({ "code_critique.enabled": true });
    const result = parseCodeCritique('{"decision":"changes_requested","summary":"gap","findings":[{"id":"f1","severity":"blocking","finding":"missing test","criterion":"verify"}]}');
    expect(shouldRequestRepair({ settings, result, round:0 })).toBe(true);
    expect(shouldRequestRepair({ settings, result, round:1 })).toBe(false);
    expect(sameUnresolvedFindings(result.findings, result.findings)).toBe(true);
  });

  it("parses a writer dispute without treating it as a self-clear", () => {
    const reply = parseWriterRepairReply('{"replies":[{"id":"f1","status":"disputed","evidence":"already covered"}]}');
    expect(reply?.replies[0]?.status).toBe("disputed");
  });

  it("resolves an outstanding attempt+round claim before current artifact files", () => {
    const claimed = {
      artifactRevisionSha256:"pre-repair-a", revisionSha256:"pre-repair-a", findingsHash:"f",
      repairRound:1, spawnAttempted:true,
    };
    expect(nextRepairAction({
      nextRound:1, artifactRevisionSha256:"post-edit-b", revisionSha256:"post-edit-b",
      ledger:{ ...claimed, repairThreadId:"thr_repair" },
    })).toBe("wait");
    expect(nextRepairAction({
      nextRound:1, artifactRevisionSha256:"post-edit-b", revisionSha256:"post-edit-b",
      ledger:claimed,
    })).toBe("unknown");
    expect(nextRepairAction({
      nextRound:1, artifactRevisionSha256:"pre-repair-a", revisionSha256:"pre-repair-a",
      ledger:{ ...claimed, repairThreadId:"thr_repair", repairObserved:true },
    })).toBe("spawn");
    expect(nextRepairAction({ nextRound:1, revisionSha256:"abc" })).toBe("spawn");
  });

  it("treats writer identity as the original attempt snapshot, not a stageId label", () => {
    const original = {
      attemptId:"a1", providerId:"codex", model:"gpt-6-luna", reasoningLevel:"medium",
      serviceTier:"default" as const, environmentId:"env-1", workspacePath:"/tmp/stage-writer",
    };
    expect(sameWriterIdentity(original, { ...original })).toBe(true);
    expect(sameWriterIdentity(original, { ...original, providerId:"critic" })).toBe(false);
    expect(sameWriterIdentity(original, { ...original, attemptId:"a2" })).toBe(false);
    expect(findingsHash([{ id:"f1", severity:"blocking", finding:"x", criterion:"y" }])).toMatch(/^[a-f0-9]{64}$/);
  });

  it("requires host-read file bytes and verification io, not only hashes and exit codes", () => {
    const hashes = { "note.txt": sha256Text("FORBIDDEN_TOKEN=real-bytes\n") };
    const truncated = buildCandidateEvidence({
      produced:["note.txt"], hashes, verification:[{ command:"test -f note.txt", exitCode:0 }],
      output:"ok", ownsPaths:["note.txt"], neverTouch:[".git/**"], dirtOk:true,
    });
    expect(truncated.truncated).toBe(true);
    expect(truncated.truncateReason).toContain("missing_content");
    expect(truncated.truncateReason).toContain("missing_verification_io");
    const packet = buildCandidateEvidence({
      produced:["note.txt"], hashes, files:[{ path:"note.txt", content:"FORBIDDEN_TOKEN=real-bytes\n" }],
      verification:[{ command:"test -f note.txt", exitCode:0, stdout:"", stderr:"" }],
      output:"ok", ownsPaths:["note.txt"], neverTouch:[".git/**"], dirtOk:true,
    });
    expect(packet.truncated).toBe(false);
    expect(packet.files[0]?.content).toBe("FORBIDDEN_TOKEN=real-bytes\n");
    expect(packet.verification[0]).toMatchObject({ command:"test -f note.txt", exitCode:0, stdout:"", stderr:"" });
  });

  it("keeps artifact revision when writer reply or stdout change, and splits evidence identity", () => {
    const shared = {
      produced:["note.txt"], hashes:{ "note.txt": sha256Text("same file\n") }, files:[{ path:"note.txt", content:"same file\n" }],
      ownsPaths:["note.txt"], neverTouch:[".git/**"] as string[], dirtOk:true,
    };
    const first = buildCandidateEvidence({
      ...shared, output:"writer created note.txt",
      verification:[{ command:"test -f note.txt", exitCode:0, stdout:"", stderr:"" }],
    });
    const replyChanged = buildCandidateEvidence({
      ...shared, output:"writer created note.txt\nmore explanation",
      verification:[{ command:"test -f note.txt", exitCode:0, stdout:"", stderr:"" }],
    });
    const stdoutChanged = buildCandidateEvidence({
      ...shared, output:"writer created note.txt",
      verification:[{ command:"test -f note.txt", exitCode:0, stdout:"ok\n", stderr:"" }],
    });
    expect(first.hashes).toEqual(replyChanged.hashes);
    expect(first.artifactRevisionSha256).toBe(replyChanged.artifactRevisionSha256);
    expect(first.artifactRevisionSha256).toBe(stdoutChanged.artifactRevisionSha256);
    expect(first.evidenceSha256).not.toBe(replyChanged.evidenceSha256);
    expect(first.evidenceSha256).not.toBe(stdoutChanged.evidenceSha256);
    expect(codeCritiqueSource({ evidence:first, task:{}, agent:"c" })).not.toBe(codeCritiqueSource({ evidence:replyChanged, task:{}, agent:"c" }));
  });

  it("keeps frozen reviewer settings when live project settings change", () => {
    const frozen = freezeCritiquePolicy({
      settings:parseCodeCritiqueSettings({ "code_critique.enabled":true, "code_critique.max_rounds":1, "code_critique.model":"critic-model" }),
      providerId:"critic", model:"critic-model", reasoningEffort:"medium", serviceTier:"standard",
    });
    const live = parseCodeCritiqueSettings({ "code_critique.enabled":true, "code_critique.max_rounds":3, "code_critique.model":"other-model" });
    expect(live.maxRounds).toBe(3);
    expect(settingsFromFrozenPolicy(frozen).maxRounds).toBe(1);
    expect(frozen.model).toBe("critic-model");
    const ledger = repairLedgerFromResult({
      artifactRevisionSha256:"abc", revisionSha256:"abc", findingsHash:"f", repairRound:1, spawnAttempted:true, repairThreadId:"thr_repair",
      policy:frozen,
    });
    expect(ledger?.policy?.model).toBe("critic-model");
    expect(ledger?.policy?.maxRounds).toBe(1);
    expect(ledger?.repairRound).toBe(1);
    expect(persistLedgerFields({
      artifactRevisionSha256:"abc", revisionSha256:"abc", findingsHash:"f", repairRound:1, spawnAttempted:true, repairThreadId:"thr_repair",
      policy:frozen,
    })).toMatchObject({ repairRound:1, spawnAttempted:true, repairThreadId:"thr_repair" });
  });

  it("marks verification stdout/stderr truncation at N+1 and keeps N complete", () => {
    const content = "ok\n";
    const hashes = { "note.txt": sha256Text(content) };
    const atLimit = "x".repeat(MAX_VERIFICATION_IO_BYTES);
    const complete = buildCandidateEvidence({
      produced:["note.txt"], hashes, files:[{ path:"note.txt", content }],
      verification:[{ command:"echo", exitCode:0, stdout:atLimit, stderr:"" }],
      output:"ok", ownsPaths:["note.txt"], neverTouch:[".git/**"], dirtOk:true,
    });
    expect(complete.truncated).toBe(false);
    expect(complete.verification[0]?.stdout).toBe(atLimit);
    const over = buildCandidateEvidence({
      produced:["note.txt"], hashes, files:[{ path:"note.txt", content }],
      verification:[{ command:"echo", exitCode:0, stdout:atLimit + "y", stderr:"" }],
      output:"ok", ownsPaths:["note.txt"], neverTouch:[".git/**"], dirtOk:true,
    });
    expect(over.truncated).toBe(true);
    expect(over.truncateReason).toContain("verification_io_truncated");
    expect(over.verification[0]?.stdout).toBe(atLimit);
    const stderrOver = buildCandidateEvidence({
      produced:["note.txt"], hashes, files:[{ path:"note.txt", content }],
      verification:[{ command:"echo", exitCode:1, stdout:"", stderr:atLimit + "z" }],
      output:"ok", ownsPaths:["note.txt"], neverTouch:[".git/**"], dirtOk:true,
    });
    expect(stderrOver.truncateReason).toContain("verification_io_truncated");
  });

  it("marks unknown when host-read bytes do not match the captured path hash", () => {
    const content = "host-read bytes\n";
    const mismatch = buildCandidateEvidence({
      produced:["note.txt"], hashes:{ "note.txt": sha256Text("dirt hash only\n") },
      files:[{ path:"note.txt", content }],
      verification:[{ command:"test -f note.txt", exitCode:0, stdout:"", stderr:"" }],
      output:"ok", ownsPaths:["note.txt"], neverTouch:[".git/**"], dirtOk:true,
    });
    expect(mismatch.truncated).toBe(true);
    expect(mismatch.truncateReason).toContain("content_hash_mismatch:note.txt");
    const matched = buildCandidateEvidence({
      produced:["note.txt"], hashes:{ "note.txt": sha256Text(content) },
      files:[{ path:"note.txt", content }],
      verification:[{ command:"test -f note.txt", exitCode:0, stdout:"", stderr:"" }],
      output:"ok", ownsPaths:["note.txt"], neverTouch:[".git/**"], dirtOk:true,
    });
    expect(matched.truncated).toBe(false);
  });
});
