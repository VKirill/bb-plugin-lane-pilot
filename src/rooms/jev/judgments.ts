/**
 * Every judgment registered in this process, for CLI and reports. Imported for side effects only: a judgment registers
 * itself on import, so this list is the inventory `listJudgments` sees. Each room is entered through its index only.
 */
import "@lane-pilot/jev/judgments/invoice-check";
import "@lane-pilot/jev/judgments/output-guard";
import "@lane-pilot/jev/judgments/repair-group";
import "@lane-pilot/jev/judgments/skill-pick";
import "@lane-pilot/jev/judgments/trace-checks";
import "@lane-pilot/jev/judgments/ui-shots";
import "@lane-pilot/jev/judgments/host-command";
import "../anamnesis";
import "../learning";
import "../phase";
import "../runs";
import "../workflow";
import "../writer";
import "@lane-pilot/jev/judgments/citation-check";
