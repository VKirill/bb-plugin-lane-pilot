import {
  ArrowUp01Icon,
  ArrowUpRight01Icon,
  Clock01Icon,
  GitBranchIcon,
  Layers01Icon,
  LockIcon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { type ExtendedIconMap, registerExtendedIcons } from "./icon-registry";

export const EXTENDED_ICON_MAP: ExtendedIconMap = {
  ArrowUpRight: ArrowUpRight01Icon,
  ChevronUp: ArrowUp01Icon,
  Clock: Clock01Icon,
  GitBranch: GitBranchIcon,
  Layers: Layers01Icon,
  Lock: LockIcon,
  RotateCcw: Refresh01Icon,
};

registerExtendedIcons(EXTENDED_ICON_MAP);
