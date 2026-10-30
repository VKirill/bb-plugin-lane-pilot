/**
 * Every judgment registered in this process, for CLI and reports. Imported for side effects only: a judgment registers
 * itself on import, so this list is the inventory `listJudgments` sees.
 */
import "@lane-pilot/jev/judgments/invoice-check";
import "@lane-pilot/jev/judgments/output-guard";
import "@lane-pilot/jev/judgments/repair-group";
import "@lane-pilot/jev/judgments/skill-pick";
import "@lane-pilot/jev/judgments/trace-checks";
import "../anamnesis/judgment";
import "../learning/judgment";
import "../learning/pm-rules";
import "../learning/signals";
import "../phase/intake";
import "../runs/failure-class-judgment";
import "../workflow/route-workflow";
import "../writer/writer-model-pick";
