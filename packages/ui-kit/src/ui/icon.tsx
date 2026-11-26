import type { CSSProperties } from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  Archive03Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  BotIcon,
  Bug01Icon,
  Cancel01Icon,
  CheckListIcon,
  CheckmarkCircle02Icon,
  CircleIcon,
  FolderGitTwoIcon,
  FolderIcon,
  InformationCircleIcon,
  MessageQuestionIcon,
  MoreHorizontalIcon,
  Search01Icon,
  SourceCodeIcon,
  Target02Icon,
  Tick02Icon,
  UserAdd01Icon,
  WorkflowCircle03Icon,
  ZapIcon,
} from "@hugeicons/core-free-icons";
import { useSyncExternalStore } from "react";
import { cn } from "../lib/utils";
import {
  EXTENDED_ICON_NAMES,
  type ExtendedIconName,
  getExtendedIcons,
  subscribeExtendedIcons,
} from "./icon-registry";

const SectionAddStrokeRoundedIcon: IconSvgElement = [
  [
    "path",
    {
      d: "M2 3.4C2 2.24173 2.24173 2 3.4 2H20.6C21.7583 2 22 2.24173 22 3.4V4.6C22 5.75827 21.7583 6 20.6 6H3.4C2.24173 6 2 5.75827 2 4.6V3.4Z",
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeWidth: "1.5",
      key: "0",
    },
  ],
  [
    "path",
    {
      d: "M2 11.4C2 10.2417 2.24173 10 3.4 10H10.6C11.7583 10 12 10.2417 12 11.4V12.6C12 13.7583 11.7583 14 10.6 14H3.4C2.24173 14 2 13.7583 2 12.6V11.4Z",
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeWidth: "1.5",
      key: "1",
    },
  ],
  [
    "path",
    {
      d: "M2 19.4C2 18.2417 2.24173 18 3.4 18H10.6C11.7583 18 12 18.2417 12 19.4V20.6C12 21.7583 11.7583 22 10.6 22H3.4C2.24173 22 2 21.7583 2 20.6V19.4Z",
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeWidth: "1.5",
      key: "2",
    },
  ],
  [
    "path",
    {
      d: "M18 13V21M22 17H14",
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeWidth: "1.5",
      key: "3",
    },
  ],
];

const CORE_ICON_MAP = {
  Archive: Archive03Icon,
  Bot: BotIcon,
  Bug: Bug01Icon,
  Check: Tick02Icon,
  ChevronDown: ArrowDown01Icon,
  ChevronRight: ArrowRight01Icon,
  Circle: CircleIcon,
  CircleCheck: CheckmarkCircle02Icon,
  Code: SourceCodeIcon,
  Folder: FolderIcon,
  FolderGit: FolderGitTwoIcon,
  Info: InformationCircleIcon,
  ListTodo: CheckListIcon,
  MessageQuestion: MessageQuestionIcon,
  MoreHorizontal: MoreHorizontalIcon,
  Search: Search01Icon,
  SectionAdd: SectionAddStrokeRoundedIcon,
  Target: Target02Icon,
  UserRoundPlus: UserAdd01Icon,
  Workflow: WorkflowCircle03Icon,
  X: Cancel01Icon,
  Zap: ZapIcon,
} as const satisfies Record<string, IconSvgElement>;

type CoreIconName = keyof typeof CORE_ICON_MAP;

export type BuiltinIconName = CoreIconName | ExtendedIconName;
export type IconName = string;

const CORE_ICON_NAMES = Object.keys(CORE_ICON_MAP) as readonly CoreIconName[];

export const ICON_NAMES: readonly BuiltinIconName[] = [
  ...CORE_ICON_NAMES,
  ...EXTENDED_ICON_NAMES,
];

const CORE_ICON_LOOKUP: Readonly<Record<string, IconSvgElement | undefined>> =
  CORE_ICON_MAP;

let extendedIconsLoad: Promise<void> | null = null;

export function preloadExtendedIcons(): Promise<void> {
  if (getExtendedIcons() !== null) return Promise.resolve();
  extendedIconsLoad ??= import("./icon-extended").then(
    () => undefined,
    (error: unknown) => {
      extendedIconsLoad = null;
      throw error;
    },
  );
  return extendedIconsLoad;
}

const EMPTY_ICON: IconSvgElement = [];

export interface IconProps {
  name: IconName;
  fallback?: string;
  className?: string;
  style?: CSSProperties;
  "aria-hidden"?: boolean | "true" | "false";
  "aria-label"?: string;
}

const ICON_NAME_SET: ReadonlySet<string> = new Set(ICON_NAMES);

export function isBuiltinIconName(name: string): name is BuiltinIconName {
  return ICON_NAME_SET.has(name);
}

export function Icon({ name, fallback = "Zap", ...props }: IconProps) {
  const resolved = isBuiltinIconName(name) ? name : fallback;
  return (
    <BuiltinIcon
      name={isBuiltinIconName(resolved) ? resolved : "Zap"}
      {...props}
    />
  );
}

function BuiltinIcon({
  name,
  className,
  style,
  "aria-hidden": ariaHidden,
  "aria-label": ariaLabel,
}: IconProps) {
  const coreIcon = CORE_ICON_LOOKUP[name];
  if (coreIcon !== undefined) {
    return (
      <HugeiconsIcon
        icon={coreIcon}
        className={cn(className)}
        style={style}
        aria-hidden={ariaHidden}
        aria-label={ariaLabel}
        data-icon={name}
      />
    );
  }
  return (
    <ExtendedIcon
      name={name}
      className={className}
      style={style}
      aria-hidden={ariaHidden}
      aria-label={ariaLabel}
    />
  );
}

function ExtendedIcon({
  name,
  className,
  style,
  "aria-hidden": ariaHidden,
  "aria-label": ariaLabel,
}: IconProps) {
  const extendedIcons: Readonly<
    Record<string, IconSvgElement | undefined>
  > | null = useSyncExternalStore(
    subscribeExtendedIcons,
    getExtendedIcons,
    getExtendedIcons,
  );
  const icon = extendedIcons?.[name];
  if (icon === undefined) {
    void preloadExtendedIcons().catch(() => undefined);
  }
  return (
    <HugeiconsIcon
      icon={icon ?? EMPTY_ICON}
      className={cn(className)}
      style={style}
      aria-hidden={ariaHidden}
      aria-label={ariaLabel}
      data-icon={name}
      data-icon-pending={icon === undefined ? "" : undefined}
    />
  );
}
