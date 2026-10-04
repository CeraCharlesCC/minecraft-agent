export interface StartSessionInput {
  detail?: "compact" | "full";
  session: string;
  host: string;
  port: number;
  username: string;
  auth: string;
  version?: string;
  autoReconnect?: boolean;
  reconnectMaxAttempts?: number;
  reconnectBackoff?: number;
}

export interface SessionInput {
  session: string;
  detail?: "compact" | "full";
  context?: string;
  runtimeId?: string;
  worldEpoch?: number;
  wait?: number;
  observe?: boolean;
}

export interface EventsInput extends SessionInput {
  profile?: "all" | "agent";
  since: 0 | string;
  limit: number;
  types: string[];
}

export interface WatchInput extends SessionInput {
  excludeSelf?: boolean;
  profile?: "all" | "agent";
  since: 0 | string;
  types: string[];
  track?: string;
  fields?: string[];
  rate?: number;
}

export interface SurroundingsInput extends Omit<SessionInput, "detail"> {
  range?: number;
  detail?: boolean;
  bounds?: { min: [number, number, number]; max: [number, number, number] };
}

export interface FrameInput extends SessionInput {
  detail?: "compact" | "full";
  since?: string;
  maxEntities: number;
  radius: number;
  tracks: string[];
}

export interface DebugEventsInput extends SessionInput {
  id?: string;
}

export interface ActionInput extends SessionInput {
  action: string;
}

export interface ActionStopInput extends SessionInput { resources?: ("movement" | "look" | "item" | "window")[] }

export interface ActionWaitInput extends ActionInput { timeout: number }

export interface EnsureReadyInput extends SessionInput { timeout: number; maxAttempts: number; backoff: number }

export interface ChatInput extends SessionInput {
  message: string;
  allowCommand: boolean;
}

export interface WhisperInput extends SessionInput {
  username: string;
  message: string;
}

export interface TabCompleteInput extends SessionInput {
  text: string;
  assumeCommand: boolean;
  sendBlockInSight: boolean;
  timeout: number;
}

export interface ControlTapInput extends SessionInput {
  state: string;
  durationMs: number;
}

export interface ControlSetInput extends SessionInput {
  state: string;
  value: boolean;
}

export interface LookAtInput extends SessionInput {
  x: number;
  y: number;
  z: number;
}

export interface LookInput extends SessionInput {
  yaw: number;
  pitch: number;
  force: boolean;
}

export interface BlockPositionInput extends SessionInput {
  x: number;
  y: number;
  z: number;
}

export interface FindBlocksInput extends SessionInput {
  name: string;
  radius: number;
  count: number;
}

export interface CursorBlockInput extends SessionInput {
  maxDistance: number;
}

export interface NavigateGotoInput extends BlockPositionInput {
  range: number;
}

export interface NavigateFollowInput extends SessionInput {
  track: string;
  range: number;
}

export interface NavigateConfigureInput extends SessionInput {
  allowDig?: boolean;
  allowPlace?: boolean;
  allowSprinting?: boolean;
  allowParkour?: boolean;
  canOpenDoors?: boolean;
  maxDropDown?: number;
}

export interface NavigateTuningInput extends SessionInput {
  searchRadius?: number;
  thinkTimeout?: number;
  tickTimeout?: number;
}

export interface CollectItemInput extends SessionInput {
  track: string;
  range: number;
}

export interface EquipInput extends SessionInput {
  item: string;
  destination: string;
}

export interface UnequipInput extends SessionInput {
  destination: string;
}

export interface QuickBarInput extends SessionInput {
  slot: number;
}

export interface TossInput extends SessionInput {
  item: string;
  count: number;
}

export interface RecipesInput extends SessionInput {
  item: string;
  count: number;
  tableX?: number;
  tableY?: number;
  tableZ?: number;
}

export interface CraftInput extends SessionInput {
  item: string;
  count: number;
  tableX?: number;
  tableY?: number;
  tableZ?: number;
  recipeIndex?: number;
  recipeId?: string;
}

export interface PlaceBlockInput extends BlockPositionInput {
  face: string;
  item?: string;
}

export interface UpdateSignInput extends BlockPositionInput {
  text: string;
  back: boolean;
}

export interface EntityInput extends SessionInput {
  track: string;
}

export interface EntityAttackInput extends EntityInput {
  allowPlayers?: boolean;
  allowPassive?: boolean;
}

export interface EntityFindInput extends SessionInput {
  name?: string;
  types?: string[];
  radius: number;
  limit: number;
}

export interface MoveVehicleInput extends SessionInput {
  left: number;
  forward: number;
}

export interface WindowItemInput extends SessionInput {
  item: string;
  count: number;
}

export interface WindowClickInput extends SessionInput {
  slot: number;
  mouseButton: number;
  mode: number;
}

export interface DaemonRunInput extends StartSessionInput {
  controlPort: number;
}

export interface CliHandlers {
  observeFrame?(input: FrameInput): Promise<unknown>;
  observeSurroundings?(input: SurroundingsInput): Promise<unknown>;
  debugEvents?(input: DebugEventsInput): Promise<unknown>;
  debugSession?(input: SessionInput): Promise<unknown>;
  sessionEnsureReady?(input: EnsureReadyInput): Promise<unknown>;
  actionWait?(input: ActionWaitInput): Promise<unknown>;
  actionStatus?(input: ActionInput): Promise<unknown>;
  actionStop?(input: ActionStopInput): Promise<unknown>;
  actionCancel?(input: ActionInput): Promise<unknown>;
  lookTrack?(input: EntityInput): Promise<unknown>;
  startSession(input: StartSessionInput): Promise<unknown>;
  sessionStatus(input: SessionInput): Promise<unknown>;
  listSessions(input?: { detail?: "compact" | "full" }): Promise<unknown>;
  stopSession(input: SessionInput): Promise<unknown>;
  observeEvents(input: EventsInput): Promise<unknown>;
  observeWatch(input: WatchInput): Promise<void>;
  sendChat(input: ChatInput): Promise<unknown>;
  sendWhisper(input: WhisperInput): Promise<unknown>;
  tabComplete(input: TabCompleteInput): Promise<unknown>;
  botPlayers(input: SessionInput): Promise<unknown>;
  botTablist(input: SessionInput): Promise<unknown>;
  botScoreboards(input: SessionInput): Promise<unknown>;
  botTeams(input: SessionInput): Promise<unknown>;
  controlTap(input: ControlTapInput): Promise<unknown>;
  controlSet(input: ControlSetInput): Promise<unknown>;
  lookAt(input: LookAtInput): Promise<unknown>;
  look(input: LookInput): Promise<unknown>;
  worldBlock(input: BlockPositionInput): Promise<unknown>;
  worldBlockAtCursor(input: CursorBlockInput): Promise<unknown>;
  worldFindBlocks(input: FindBlocksInput): Promise<unknown>;
  navigateGoto(input: NavigateGotoInput): Promise<unknown>;
  navigateFollow(input: NavigateFollowInput): Promise<unknown>;
  navigateConfigure(input: NavigateConfigureInput): Promise<unknown>;
  navigateTune(input: NavigateTuningInput): Promise<unknown>;
  collectItem(input: CollectItemInput): Promise<unknown>;
  inventoryEquip(input: EquipInput): Promise<unknown>;
  inventoryUnequip(input: UnequipInput): Promise<unknown>;
  inventoryQuickBar(input: QuickBarInput): Promise<unknown>;
  inventoryToss(input: TossInput): Promise<unknown>;
  inventoryConsume(input: SessionInput): Promise<unknown>;
  inventoryFish(input: SessionInput): Promise<unknown>;
  inventoryActivateItem(input: SessionInput & { offhand: boolean }): Promise<unknown>;
  inventoryRecipes(input: RecipesInput): Promise<unknown>;
  inventoryCraft(input: CraftInput): Promise<unknown>;
  worldDig(input: BlockPositionInput): Promise<unknown>;
  worldPlace(input: PlaceBlockInput): Promise<unknown>;
  worldPlaceEntity(input: PlaceBlockInput): Promise<unknown>;
  worldActivate(input: BlockPositionInput): Promise<unknown>;
  worldUpdateSign(input: UpdateSignInput): Promise<unknown>;
  worldSleep(input: BlockPositionInput): Promise<unknown>;
  worldWake(input: SessionInput): Promise<unknown>;
  worldElytraFly(input: SessionInput): Promise<unknown>;
  windowOpenBlock(input: BlockPositionInput): Promise<unknown>;
  windowOpenEntity(input: EntityInput): Promise<unknown>;
  windowDeposit(input: WindowItemInput): Promise<unknown>;
  windowWithdraw(input: WindowItemInput): Promise<unknown>;
  windowClick(input: WindowClickInput): Promise<unknown>;
  windowClose(input: SessionInput): Promise<unknown>;
  entityFind(input: EntityFindInput): Promise<unknown>;
  entityInspect(input: EntityInput): Promise<unknown>;
  entityInteract(input: EntityInput): Promise<unknown>;
  entityAttack(input: EntityAttackInput): Promise<unknown>;
  entityMount(input: EntityInput): Promise<unknown>;
  entityDismount(input: SessionInput): Promise<unknown>;
  entityMoveVehicle(input: MoveVehicleInput): Promise<unknown>;
  daemonRun(input: DaemonRunInput): Promise<unknown>;
}
