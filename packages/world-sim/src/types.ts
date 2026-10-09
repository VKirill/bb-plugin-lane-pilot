/**
 * Data model of the world. Everything here is plain JSON (numbers, strings, arrays, records) so a `WorldState` can be
 * stored, cloned with `JSON.parse(JSON.stringify())` and sent to a browser as is. Coordinates are world units on the
 * ground plane: `x` east, `z` south, one unit is one tile; the office block sits at the origin.
 */

export const WORLD_SCHEMA_VERSION = 1;

export type Vec = { x: number; z: number };

// ---- needs and actions ----

export const NEED_KEYS = ["energy", "hunger", "social", "fun", "work"] as const;
export type NeedKey = (typeof NEED_KEYS)[number];
/** Every need is a satisfaction level: 1 is fully satisfied, 0 is desperate. */
export type Needs = Record<NeedKey, number>;

export const ACTIONS = ["work", "eat", "chat", "rest", "sleep", "park", "shop", "build", "repair", "inspect", "meeting", "drive", "wait"] as const;
export type ActionKind = (typeof ACTIONS)[number];
/** The actions a citizen picks for itself by utility; the others come from jobs, signals and scenarios. */
export const CHOSEN_ACTIONS = ["work", "eat", "chat", "rest", "park", "shop"] as const;
export type ChosenAction = (typeof CHOSEN_ACTIONS)[number];

/**
 * What an actor does for a while. The hub sends plans, not positions: a client interpolates along `path` from `startAt`
 * at `speed` (units per sim second), then plays `clip` at the end of the path until `until` (sim seconds).
 * An actor without a plan stands where its last plan ended.
 */
export type Plan = {
  id: string;
  actorId: string;
  action: ActionKind;
  path: Vec[];
  startAt: number;
  speed: number;
  /** When the actor reaches the end of the path. */
  arriveAt: number;
  until: number;
  /** Animation to play at the end of the path (`walk`/`drive` while moving is implied by the actor kind). */
  clip: string;
  /** Point of interest or building the plan is about. */
  target?: string;
  /** Vehicles drive on the right: shift the path this many units to the right of the travel direction. */
  lateral?: number;
};

// ---- map ----

export type GraphKind = "walk" | "cross" | "enter" | "interior" | "road";
export type GNode = { id: number; x: number; z: number };
export type GEdge = { a: number; b: number; len: number; kind: GraphKind };
export type Graph = { nodes: GNode[]; edges: GEdge[] };

export type BlockKind = "office" | "residential" | "commercial" | "industrial" | "park" | "free";
export type Block = { id: string; i: number; j: number; x0: number; z0: number; x1: number; z1: number; kind: BlockKind; corners: number[] };

export type PlotSlot = { x: number; z: number; node: number; kind?: string; clip?: string };
export type Plot = {
  id: string;
  blockId: string;
  zone: BlockKind;
  /** Footprint of the building. */
  x0: number; z0: number; x1: number; z1: number;
  /** Street side the door faces. */
  side: "n" | "s";
  /** Node on the sidewalk graph in front of the door and the node just inside the footprint. */
  doorNode: number;
  entryNode: number;
  /** Nodes on the road graph in front of the plot, where vehicles stop. */
  roadNode: number;
  slots: PlotSlot[];
};

/** Static geometry; generated once from the seed and never changed afterwards. */
export type WorldMap = {
  /** Tile grid: row-major digits, 0 grass, 1 road, 2 sidewalk, 3 plot ground, 4 office, 5 park. */
  grid: { w: number; d: number; x0: number; z0: number; tiles: string };
  blocks: Block[];
  plots: Record<string, Plot>;
  sidewalk: Graph;
  road: Graph;
  /** Where Lane Pilot's own building sits. */
  officePlotId: string;
  depotPlotId: string;
};

// ---- entities ----

export type CitizenRole = "worker" | "builder" | "inspector" | "resident";
export type Citizen = {
  id: string;
  name: string;
  role: CitizenRole;
  /** Look hint for the client (palette index). */
  look: number;
  homeId: string;
  workId: string | null;
  /** Dedicated desk (office workers). */
  deskPoi: string | null;
  speed: number;
  pos: Vec;
  /** Sidewalk node the citizen stands on when it has no moving plan. */
  node: number;
  needs: Needs;
  plan: Plan | null;
  jobId: string | null;
  /** Point of interest the current plan reserved (released at the next decision). */
  poi: string | null;
};

export type VehicleKind = "truck" | "van" | "car";
export type Vehicle = {
  id: string;
  kind: VehicleKind;
  pos: Vec;
  node: number;
  plan: Plan | null;
  /** Why it exists: a delivery job or a rescue call. */
  jobId: string | null;
  label?: string;
};

export type BuildingKind = "house" | "cafe" | "shop" | "office" | "depot" | "park" | "warehouse" | "workshop";
export type Poi = { id: string; buildingId: string; kind: string; x: number; z: number; node: number; clip: string };
export type Building = {
  id: string;
  plotId: string;
  kind: BuildingKind;
  name: string;
  districtId: string | null;
  poiIds: string[];
  /** Why it exists: the site it was built from. */
  siteId: string | null;
  openedAt: number;
};

export type District = { id: string; projectId: string; name: string; blockId: string; color: number; plotIds: string[]; createdAt: number };

export const STAGES = ["survey", "foundation", "frame", "walls", "roof", "paint", "open"] as const;
export type StageName = (typeof STAGES)[number];

export type Site = {
  id: string;
  projectId: string;
  districtId: string;
  taskId: string;
  attemptIds: string[];
  plotId: string;
  blueprint: BuildingKind;
  name: string;
  stageIndex: number;
  /** Work done on the current stage, 0 to 1. */
  progress: number;
  /** The highest stage the crew may work on (Lane Pilot decides it). */
  target: number;
  delivered: boolean[];
  ordered: boolean[];
  collapsed: boolean;
  /** Set by a failed verification, cleared by a passed one. */
  rejected: boolean;
  approved: boolean;
  rush: boolean;
  buildingId: string | null;
  createdAt: number;
  openedAt: number | null;
};

export type JobKind = "build" | "repair" | "deliver" | "inspect" | "rescue";
export type Job = {
  id: string;
  kind: JobKind;
  siteId: string | null;
  state: "open" | "active" | "done";
  crew: string[];
  need: number;
  vehicleId: string | null;
  /** Deliver: the stage whose materials are carried; repair: crew-seconds still to do; rescue: the call id. */
  stage: number;
  workLeft: number;
  phase: "to_site" | "unload" | "return" | "work";
  createdAt: number;
  until: number;
};

export type Meeting = { id: string; seats: string[]; citizenIds: string[]; since: number };

// ---- scenarios ----

export type HourRange = [number, number];
export type CitizenFilter = { role?: CitizenRole | CitizenRole[]; hasWork?: boolean; hasDesk?: boolean; workKind?: BuildingKind };

export type Routine = {
  id: string;
  hours: HourRange;
  who?: CitizenFilter;
  action: ChosenAction;
  /** `bias` adds `weight` to the action's utility; `force` makes it the pick when the citizen decides. */
  mode: "bias" | "force";
  weight?: number;
  /** Chance a citizen follows a `force` routine at a decision. */
  chance?: number;
};

export type Condition =
  | { fact: "hour"; op: ">=" | "<=" | "<" | ">" | "=="; value: number }
  | { fact: "sitesNeedingMaterials" | "openSites" | "idleCitizens" | "vehicles"; op: ">=" | "<=" | "<" | ">" | "=="; value: number }
  | { fact: "chance"; value: number };

export type Effect =
  | { type: "delivery"; target: "neediest_site" }
  | { type: "spawn_traffic"; kind?: VehicleKind; count?: number }
  | { type: "damage_site"; target: "random_site" }
  | { type: "force_action"; who?: CitizenFilter; action: ChosenAction; forHours: number };

export type ScriptedEvent = {
  id: string;
  hours?: HourRange;
  /** Minimum game hours between two firings. */
  cooldownHours?: number;
  if?: Condition[];
  do: Effect[];
};

export type Scenario = { id: string; title: string; routines: Routine[]; events: ScriptedEvent[] };

export type ScenarioRuntime = { lastFired: Record<string, number>; forced: Array<{ filter: CitizenFilter | null; action: ChosenAction; until: number }>; lastCheck: number };

// ---- state ----

export type WorldConfig = {
  /** Sim seconds in one game hour; a day lasts 24 of them. */
  hourSeconds: number;
  /** The fixed step `step` advances by. */
  fixedStep: number;
  scenarios: string[];
  /** Game hour the clock starts at. */
  startHour: number;
};

export type WorldState = {
  schema: number;
  seed: number;
  /** Serialisable generator state (mulberry32). */
  rng: number;
  config: WorldConfig;
  /** Sim seconds since the world was created. */
  time: number;
  tick: number;
  /** Time carried between `step` calls that were shorter than a fixed step. */
  carry: number;
  counters: Record<string, number>;
  eventSeq: number;
  map: WorldMap;
  citizens: Record<string, Citizen>;
  vehicles: Record<string, Vehicle>;
  buildings: Record<string, Building>;
  pois: Record<string, Poi>;
  /** Plot id to building id and site id. */
  plotBuilding: Record<string, string>;
  plotSite: Record<string, string>;
  plotDistrict: Record<string, string>;
  districts: Record<string, District>;
  sites: Record<string, Site>;
  jobs: Record<string, Job>;
  meetings: Record<string, Meeting>;
  /** Project id to district id. */
  projects: Record<string, string>;
  /** Attempt id to site id. */
  attempts: Record<string, string>;
  /** Task key `${projectId}/${taskId}` to site id. */
  tasks: Record<string, string>;
  /** Soft occupancy of points of interest. */
  poiLoad: Record<string, number>;
  /** Rescue calls: id to the site (or district) the van goes to. */
  calls: Record<string, { target: string; vehicleId: string | null; since: number }>;
  scenario: ScenarioRuntime;
  /** Bumped when buildings change so derived indexes rebuild. */
  rev: number;
};

// ---- signals (Lane Pilot to world) ----

export type LanePilotSignal =
  | { type: "project_upserted"; projectId: string; name?: string }
  | { type: "task_dispatched"; projectId: string; taskId: string; attemptId: string; title?: string }
  | { type: "attempt_progress"; attemptId: string; percent: number; stage?: string }
  | { type: "verification"; attemptId: string; phase: "started" | "passed" | "failed" }
  | { type: "accepted"; attemptId: string }
  | { type: "failed"; attemptId: string; reason?: string }
  | { type: "self_repair_started"; id: string; projectId?: string; attemptId?: string }
  | { type: "self_repair_ended"; id: string }
  | { type: "council_started"; councilId: string; projectId?: string; seats?: number }
  | { type: "council_ended"; councilId: string };

export type SignalType = LanePilotSignal["type"];

// ---- events (world to clients) ----

export type WorldEvent =
  | { seq: number; t: number; type: "plan"; plan: Plan }
  | { seq: number; t: number; type: "stage"; siteId: string; stage: StageName; stageIndex: number; progress: number }
  | { seq: number; t: number; type: "site"; siteId: string; state: "created" | "delivered" | "collapsed" | "repaired" | "rejected" | "approved" | "opened"; buildingId?: string }
  | { seq: number; t: number; type: "district"; district: District }
  | { seq: number; t: number; type: "spawned"; kind: "citizen" | "vehicle" | "building" | "site"; id: string; data: unknown }
  | { seq: number; t: number; type: "removed"; kind: "citizen" | "vehicle" | "site" | "building"; id: string }
  | { seq: number; t: number; type: "meeting"; meetingId: string; state: "started" | "ended"; citizenIds: string[] }
  | { seq: number; t: number; type: "signal"; signal: LanePilotSignal; applied: boolean; note?: string };

export type WorldEventType = WorldEvent["type"];

export type StepResult = { state: WorldState; events: WorldEvent[] };
