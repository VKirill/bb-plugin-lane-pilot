import { z } from "zod";

export const COUNCIL_STATES = ["agenda", "discussion", "synthesis", "done", "failed", "stopped"] as const;
export type CouncilState = (typeof COUNCIL_STATES)[number];

export const MESSAGE_KINDS = ["agenda", "position", "reply", "status", "decision", "owner"] as const;
export type CouncilMessageKind = (typeof MESSAGE_KINDS)[number];

export type CouncilSeat = {
  id: string;
  role: string;
  title: string;
  instruction: string;
  aliases?: string[];
  /** A reasoning level the owner fixed for the seat; otherwise the model's best supported level. */
  effort?: string;
  lens?: string;
  providerId: string | null;
  model: string | null;
};

export type CouncilSession = {
  id: string;
  projectId: string;
  runId: string;
  question: string;
  agenda: string[];
  criteria: string[];
  seats: CouncilSeat[];
  state: CouncilState;
  round: number;
  maxRounds: number;
  decision: DecisionRecord | null;
  decisionPath: string | null;
  reason: string | null;
  createdAt: number;
  updatedAt: number;
};

export type CouncilMessage = {
  seq: number;
  councilId: string;
  seatId: string;
  round: number;
  kind: CouncilMessageKind;
  text: string;
  at: number;
};

const shortText = (max: number) => z.string().trim().min(1).max(max);

export const agendaSchema = z.object({
  agenda: z.array(shortText(300)).min(1).max(8),
  criteria: z.array(shortText(200)).min(1).max(8),
}).strict();

export type Agenda = z.infer<typeof agendaSchema>;

export const decisionRecordSchema = z.object({
  summary: shortText(2000),
  options: z.array(z.object({
    title: shortText(200),
    expectedImpact: shortText(600),
    effort: z.enum(["low", "medium", "high"]),
    confidence: z.enum(["low", "medium", "high"]),
    evidence: z.array(shortText(500)).max(10).default([]),
  }).strict()).min(1).max(10),
  recommendation: shortText(2000),
  dissent: z.array(z.object({ seat: shortText(120), point: shortText(800) }).strict()).max(10).default([]),
  experiments: z.array(z.object({ hypothesis: shortText(500), metric: shortText(300) }).strict()).max(10).default([]),
  nextTasks: z.array(z.object({
    title: shortText(200),
    objective: shortText(1000),
    acceptance: z.array(shortText(400)).min(1).max(8),
    toAgent: shortText(120).optional(),
  }).strict()).max(10).default([]),
}).strict();

export type DecisionRecord = z.infer<typeof decisionRecordSchema>;

function jsonFrom(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const text = (fenced ? fenced[1] : raw).trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("no JSON object in the answer");
  return JSON.parse(text.slice(start, end + 1));
}

export function parseAgenda(raw: string): Agenda {
  return agendaSchema.parse(jsonFrom(raw));
}

export function parseDecisionRecord(raw: string): DecisionRecord {
  return decisionRecordSchema.parse(jsonFrom(raw));
}
