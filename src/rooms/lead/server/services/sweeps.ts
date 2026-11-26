import { scheduleFailureSweep } from "../../../schedule/server";
import { specialistItemSweep } from "../../../specialist/server";
import { writerQuestionSweep } from "../../../writer/server";

/** The sweeps «waiting for the owner» collects over (writer questions, schedule failures, specialist intents). */
export const OWNER_ITEM_SWEEPS = [writerQuestionSweep, scheduleFailureSweep, specialistItemSweep];
