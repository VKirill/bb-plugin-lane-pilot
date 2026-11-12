/**
 * Every judgment registered in this process, for CLI and reports. Imported for side effects only: a judgment registers
 * itself on import, so this list is the inventory `listJudgments` sees. Each room is entered through its index only.
 */
import "../critique";
import "../design-eval";
import "../anamnesis";
import "../learning";
import "../phase";
import "../runs";
import "../workflow";
import "../writer";
import "../tasks";
import "../lead";
import "@lane-pilot/jev/judgments/employee-remark";
