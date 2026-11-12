/**
 * Every judgment registered in this process, for CLI and reports. Imported for side effects only: a judgment registers
 * itself on import, so this list is the inventory `listJudgments` sees. Each room is entered through its index only.
 */
import "@lane-pilot/jev/judgments/invoice-check";
import "@lane-pilot/jev/judgments/skill-pick";
import "@lane-pilot/jev/judgments/trace-checks";
import "../critique";
import "../design-eval";
import "@lane-pilot/jev/judgments/ui-shots";
import "../anamnesis";
import "../learning";
import "../phase";
import "../runs";
import "../workflow";
import "../writer";
import "../tasks";
import "../lead";
import "@lane-pilot/jev/judgments/citation-check";
import "@lane-pilot/jev/judgments/memory-rerank";
import "@lane-pilot/jev/judgments/invoice-scan";
import "@lane-pilot/jev/judgments/log-find";
import "@lane-pilot/jev/judgments/skill-tree-pick";
import "@lane-pilot/jev/judgments/accept-composite";
import "@lane-pilot/jev/judgments/render-match";
import "@lane-pilot/jev/judgments/employee-remark";
