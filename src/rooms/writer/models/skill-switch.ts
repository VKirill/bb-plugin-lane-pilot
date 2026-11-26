export type SkillSwitchRecord = {
  id: string;
  attemptId: string;
  taskId: string;
  runId: string | null;
  projectId: string;
  skillCount: number;
  switchCount: number;
  skillsJson: string;
  outcome: string;
  recordedAt: number;
};

export type SkillSwitchStats = {
  totalTasks: number;
  avgSwitches: number;
  lowSwitchTotal: number;
  lowSwitchFailures: number;
  lowSwitchFailRate: number;
  highSwitchTotal: number;
  highSwitchFailures: number;
  highSwitchFailRate: number;
};

/**
 * Calculates the number of skill switches (transitions between different skills in sequence).
 * e.g., [A, A, B, C, C, B] -> 3 switches (A->B, B->C, C->B).
 */
export function calculateSkillSwitches(sequence: readonly string[]): {
  uniqueSkills: string[];
  switchCount: number;
} {
  const uniqueSkills = [...new Set(sequence)];
  let switchCount = 0;

  for (let i = 1; i < sequence.length; i++) {
    if (sequence[i] !== sequence[i - 1]) {
      switchCount++;
    }
  }

  return { uniqueSkills, switchCount };
}

