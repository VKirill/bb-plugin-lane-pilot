export type { BlockedBy } from "../../models/blocked-by";
export {
  isTaskSatisfied,
  loadBlockedBy,
  markTaskSatisfied,
  saveBlockedBy,
} from "../repositories/blocked-by-repository";
