import { Color, Debug, field, foldoutGroup, GameObject, Gizmos, Handles, isAlive, MonoBehaviour, Time, Vector3 } from '@pia/core';
import { EventBus } from '../EventBus';
import { ServiceLocator } from '../ServiceLocator';
import { GameEvents } from '../GameEvents';
import { Pacing } from '../Pacing';
import { GameConfiSO } from '../GameConfigSO';
import { LevelData, VehicleData } from '../Data/LevelData';
import { MotionCurves, smoothStep01 } from '../Data/MotionCurves';
import { ParkingManager } from '../Parking/ParkingManager';
import { Slot } from '../Parking/Slot';
import { Vehicle, VehicleKind } from './Vehicle';
import { quatFromAxisAngle, V3 } from '../Utils/CocosMath';
// TODO(AudioManager): the AudioManager calls of the Cocos version (playOneShot('Failed') /
// playOneShot('Go')) are kept as comments until AudioManager is ported.

/** Cocos Color.YELLOW / RED / GREEN (PiaEngine colours are 0..1). */
const GIZMO_YELLOW = new Color(1, 1, 0, 1);
const GIZMO_RED = new Color(1, 0, 0, 1);
const GIZMO_GREEN = new Color(0, 1, 0, 1);

interface BoardRect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface VehicleDimensions {
  length: number;
  width: number;
}

/** A sampled Unity-style route point. `yaw` is the visual nose direction. */
interface MotionPoint {
  position: Vector3;
  yaw: number;
  /** The body keeps its yaw while its centre travels backwards. */
  reverse: boolean;
}

/** `MotionPoint[]` plus each point's cumulative arc length, for distance-based playback. */
interface SampledRoute {
  points: MotionPoint[];
  distances: number[];
  length: number;
}

/** PlaybackDriveCommand wind-up: back up a little, then launch through the start point. */
interface DriveWindup {
  active: boolean;
  squashing: boolean;
  clock: number;
  depth: number;
  backTime: number;
  launchTime: number;
  acceleration: number;
  exitSpeed: number;
}

interface DriveOptions {
  onProgress?: (distance: number) => void;
  /** Departure leg: no stop at the route end (Unity's goEnvelope). */
  keepSpeed?: boolean;
  /** Approach leg: punchShape squash after arriving (arriveBounce*). */
  arriveBounce?: boolean;
  /** Exit leg from standstill: wind-up before following the route. */
  windup?: boolean;
}

/** PlaybackVehicleMotion.PlaybackDriveCommand, simplified to a single leg with no obstacle replanning. */
interface VehicleDrive {
  vehicle: Vehicle;
  sampled: SampledRoute;
  envelope: number[];
  curvatures: number[];
  profileSpacing: number;
  cusps: number[];
  nextCusp: number;
  distance: number;
  speed: number;
  pauseLeft: number;
  arrived: boolean;
  finished: boolean;
  keepSpeed: boolean;
  arriveBounce: boolean;
  bounceElapsed: number;
  /** Corner lean, nose pitch and tail drift (degrees). */
  roll: number;
  pitch: number;
  drift: number;
  windup: DriveWindup | null;
  coastPosition: Vector3;
  coastYaw: number;
  onProgress?: (distance: number) => void;
  onArrive: () => void;
}

/** ImpactBounceCommand, single-vehicle case: lunge toward the obstacle, punch, rebound, return. */
interface VehicleBounce {
  vehicle: Vehicle;
  origin: Vector3;
  yaw: number;
  direction: Vector3;
  halfLength: number;
  blocker: Vehicle | null;
  contactFree: number;
  peakCompression: number;
  travel: number;
  lungeSpeed: number;
  lungeAcceleration: number;
  lungeTime: number;
  reboundDistance: number;
  reboundTime: number;
  returnTime: number;
  impactTime: number;
  endTime: number;
  contactPlayed: boolean;
  elapsed: number;
}

/** ImpactShoveCommand, single hop: the blocker is pushed along the impact direction and tilts, then sways and settles. */
interface VehicleShove {
  vehicle: Vehicle;
  direction: Vector3;
  shoveTime: number;
  swayTime: number;
  elapsed: number;
}

/** FreeSpaceRoute VehicleFootprint: rule body on the XZ plane. `yaw` is the Cocos pose yaw (nose = (sin, cos)). */
interface Footprint {
  x: number;
  z: number;
  yaw: number;
  halfLength: number;
  halfWidth: number;
}

/** One ReverseIn staging pose on the lane (one per side of the slot). */
interface LineGoal {
  staging: Vector3;
  laneDirection: Vector3;
  /** Reverse-in points from just after the staging pose into the slot (slot last). */
  template: MotionPoint[];
}

/** A fillet (L-shaped) approach candidate. */
interface LinePlan {
  length: number;
  route: MotionPoint[];
  /** Length of the opening straight along the nose ray. */
  firstStraight: number;
}

interface LineSearch {
  start: Vector3;
  forward: Vector3;
  self: Footprint;
  obstacles: Footprint[];
  parked: Footprint[];
  best: number;
  plan: LinePlan | null;
  goal: LineGoal | null;
  checks: number;
}

interface VehiclePop {
  amount: number;
  duration: number;
  elapsed: number;
  onComplete?: () => void;
}

const BOUNCE_LAYER = 'bounce';
const SHOVE_LAYER = 'shove';

// Inspector groups (collapsible sections).
const GROUP_SPAWN = 'Spawn';
const GROUP_SCALE = 'Unit Scale';
const GROUP_EXIT = 'Exit Rule';
const GROUP_ROUTE = 'Route';
const GROUP_DRIVE = 'Drive';
const GROUP_BODY = 'Body Feel';
const GROUP_PARK = 'Park & Depart';
const GROUP_BOUNCE = 'Blocked Bounce';
const GROUP_VEHICLE = 'Vehicle';

export class VehicleManager extends MonoBehaviour {
  // ---------- Spawn ----------

  /** Parent for vehicles created from the level. Defaults to this GameObject. */
  @foldoutGroup(GROUP_SPAWN) @field(GameObject) spawnRoot: GameObject | null = null;
  @foldoutGroup(GROUP_SPAWN) yOffset: number = 0;

  // ---------- Unit Scale ----------

  /**
   * Every distance, speed and acceleration below is a Unity world-space value.
   * Unity draws the level at SceneLayout.BoardScale (bounds_W fitted into
   * boundsFitArea), while this scene uses level units directly, so those values
   * are multiplied by 1 / BoardScale at runtime and every motion keeps Unity's
   * timing. Set > 0 to force the factor.
   */
  @foldoutGroup(GROUP_SCALE) motionScaleOverride: number = 0;
  /**
   * Parking-area geometry (lane offset, park turn radius, overrun, departure
   * leg, slot clear distance) scales with the parked body instead: Unity shrinks
   * a parked vehicle to vehicleDesignWidth * parkingVehicleScale (0.27) while
   * this scene keeps the rule width (footprintWidth). Set > 0 to force the factor.
   */
  @foldoutGroup(GROUP_SCALE) parkingScaleOverride: number = 0;
  /** StandardSceneLayout.vehicleDesignWidth * parkingVehicleScale. */
  @foldoutGroup(GROUP_SCALE) unityParkedVehicleWidth: number = 0.27;
  /** StandardSceneLayout.boundsFitArea.size. */
  @foldoutGroup(GROUP_SCALE) unityBoundsFitWidth: number = 3.6;
  @foldoutGroup(GROUP_SCALE) unityBoundsFitDepth: number = 3.6;
  /** StandardSceneLayout.boardMaxScale. */
  @foldoutGroup(GROUP_SCALE) unityBoardMaxScale: number = 1.3;

  // ---------- Exit Rule ----------

  /** busgo-unity-2 import vehicleWidthW / team ruleset vehicles.width: rule body width in level units (all kinds). */
  @foldoutGroup(GROUP_EXIT) footprintWidth: number = 0.94;
  /**
   * Exit rule (team.ruleset.json exit, StraightExitRule): strip width as a fraction of
   * footprintWidth, strip length from the centre, and how much overlap still counts
   * as touching. Narrower / larger tolerance = fewer vehicles blocked.
   */
  @foldoutGroup(GROUP_EXIT) exitSweepWidth: number = 0.98;
  @foldoutGroup(GROUP_EXIT) exitSweepLength: number = 50;
  @foldoutGroup(GROUP_EXIT) exitOverlapTolerance: number = 0.0035;
  /** Scene view: draw rule bodies and exit strips (edit mode: the selected level). */
  @foldoutGroup(GROUP_EXIT) drawExitGizmos: boolean = true;
  /** How far a clear exit strip is drawn (the rule itself reaches exitSweepLength). */
  @foldoutGroup(GROUP_EXIT) gizmoSweepPreview: number = 10;

  // ---------- Route (FreeSpaceRoute) ----------

  /** FreeSpaceRoute.lineOuterRingMargin: how far the perimeter ring sits past the board edge. */
  @foldoutGroup(GROUP_ROUTE) exitOvershoot: number = 0.3;
  /** FreeSpaceRoute.laneOffsetZ, expressed toward the board from the slot row. */
  @foldoutGroup(GROUP_ROUTE) parkingLaneOffset: number = 0.6;
  /** FreeSpaceRoute.parkTurnRadius. */
  @foldoutGroup(GROUP_ROUTE) parkingTurnRadius: number = 0.3;
  /** FreeSpaceRoute.overrunBeforeReverse. */
  @foldoutGroup(GROUP_ROUTE) parkingOverrun: number = 0.08;
  /** FreeSpaceRoute.lineCornerRadius. */
  @foldoutGroup(GROUP_ROUTE) lineCornerRadius: number = 1.6;
  /** FreeSpaceRoute line approach (StandardFreeSpaceRoute.asset). */
  @foldoutGroup(GROUP_ROUTE) lineCornerRadiusFalloff: number = 0.6;
  @foldoutGroup(GROUP_ROUTE) lineMinCornerRadius: number = 0.2;
  @foldoutGroup(GROUP_ROUTE) lineBoardMargin: number = 0.05;
  @foldoutGroup(GROUP_ROUTE) lineTurnStep: number = 0.1;
  @foldoutGroup(GROUP_ROUTE) lineMaxCornerDegrees: number = 150;
  @foldoutGroup(GROUP_ROUTE) lineFinalStraight: number = 0.1;
  @foldoutGroup(GROUP_ROUTE) lineMaxChecks: number = 400;
  /** FreeSpaceRoute.clearance (after the first corner) / parkedClearance / collisionCheckSpacing. */
  @foldoutGroup(GROUP_ROUTE) routeClearance: number = 0.03;
  @foldoutGroup(GROUP_ROUTE) parkedClearance: number = 0.005;
  @foldoutGroup(GROUP_ROUTE) collisionCheckSpacing: number = 0.05;
  /** FreeSpaceRoute.approachSideDeadband. */
  @foldoutGroup(GROUP_ROUTE) approachSideDeadband: number = 0.1;
  /** FreeSpaceRoute.sampleSpacing. */
  @foldoutGroup(GROUP_ROUTE) routeSampleSpacing: number = 0.03;

  // ---------- Drive (StandardVehicleDrive / MotionTuning) ----------

  /** MotionTuning.vehicleSpeedScale: multiplies every speed/acceleration/time below. */
  @foldoutGroup(GROUP_DRIVE) vehicleSpeedScale: number = 1.2;
  /** PlaybackVehicleMotion / StandardVehicleDrive.cruiseSpeed. */
  @foldoutGroup(GROUP_DRIVE) @field({ label: 'Tốc độ xe' }) cruiseSpeed: number = 9;
  /** PlaybackVehicleMotion / StandardVehicleDrive.reverseSpeed. */
  @foldoutGroup(GROUP_DRIVE) @field({ label: 'Tốc độ lùi xe' }) reverseSpeed: number = 5;
  /** VehicleDriveSettings.acceleration, before vehicleSpeedScale^2. */
  @foldoutGroup(GROUP_DRIVE) acceleration: number = 24;
  /** VehicleDriveSettings.deceleration, before vehicleSpeedScale^2. */
  @foldoutGroup(GROUP_DRIVE) deceleration: number = 30;
  /** VehicleDriveSettings.launchAcceleration: eases off a standing start. */
  @foldoutGroup(GROUP_DRIVE) launchAcceleration: number = 10;
  /** VehicleDriveSettings.launchDistance. */
  @foldoutGroup(GROUP_DRIVE) launchDistance: number = 0.1;
  /** VehicleDriveSettings.lateralAcceleration: corner speed cap. */
  @foldoutGroup(GROUP_DRIVE) lateralAcceleration: number = 110;
  /** VehicleDriveSettings.gearChangePause. */
  @foldoutGroup(GROUP_DRIVE) gearChangePause: number = 0.08;
  /** VehicleDriveSettings.wheelbaseRatio (wheelbase = vehicle length * this). */
  @foldoutGroup(GROUP_DRIVE) wheelbaseRatio: number = 0.58;
  /** VehicleDriveSettings.maxSteerRate, degrees/second. */
  @foldoutGroup(GROUP_DRIVE) maxSteerRate: number = 3600;
  /** VehicleDriveSettings.steerTransitionDistance. */
  @foldoutGroup(GROUP_DRIVE) steerTransitionDistance: number = 0.1;
  /** VehicleDriveSettings.slowdownHoldDistance. */
  @foldoutGroup(GROUP_DRIVE) slowdownHoldDistance: number = 0.45;
  /** VehicleDriveSettings.peakSmoothingDistance. */
  @foldoutGroup(GROUP_DRIVE) peakSmoothingDistance: number = 0.15;
  /** MotionTuning.driveMinSpeed: minimum crawl speed so arrival always converges. */
  @foldoutGroup(GROUP_DRIVE) driveMinSpeed: number = 0.15;
  /** MotionTuning.driveProfileSpacing: sampling step for the speed envelope. */
  @foldoutGroup(GROUP_DRIVE) driveProfileSpacing: number = 0.02;
  /** MotionTuning.driveIntegrationStep: fixed sub-step (seconds) for the distance integration. */
  @foldoutGroup(GROUP_DRIVE) driveIntegrationStep: number = 0.005;
  /** Legacy value kept for the existing scene; unused (routes use cruiseSpeed). */
  @foldoutGroup(GROUP_DRIVE) driveSpeed: number = 7;

  // ---------- Body Feel (lean, pitch, drift, wind-up) ----------

  /** VehicleDriveSettings.cornerLeanPerLateralAcceleration. */
  @foldoutGroup(GROUP_BODY) cornerLeanPerLateralAcceleration: number = 0.5;
  /** VehicleDriveSettings.cornerLeanMaxAngle, degrees. */
  @foldoutGroup(GROUP_BODY) cornerLeanMaxAngle: number = 22;
  /** VehicleDriveSettings.cornerLeanResponse, seconds. */
  @foldoutGroup(GROUP_BODY) cornerLeanResponse: number = 0.1;
  /** VehicleDriveSettings.pitchPerLongitudinalAcceleration / pitchResponse / maxPitch. */
  @foldoutGroup(GROUP_BODY) pitchPerLongitudinalAcceleration: number = 0.25;
  @foldoutGroup(GROUP_BODY) pitchResponse: number = 0.08;
  @foldoutGroup(GROUP_BODY) maxPitch: number = 3;
  /** VehicleDriveSettings drift group. */
  @foldoutGroup(GROUP_BODY) driftEnabled: boolean = true;
  @foldoutGroup(GROUP_BODY) driftLateralThreshold: number = 18;
  @foldoutGroup(GROUP_BODY) driftAnglePerLateralAcceleration: number = 0.3;
  @foldoutGroup(GROUP_BODY) driftMaxAngle: number = 4;
  @foldoutGroup(GROUP_BODY) driftResponse: number = 0.1;
  @foldoutGroup(GROUP_BODY) driftRecovery: number = 0.3;
  /** VehicleDriveSettings wind-up group (tap from standstill). */
  @foldoutGroup(GROUP_BODY) windupDistance: number = 0.1;
  @foldoutGroup(GROUP_BODY) windupBackDuration: number = 0.08;
  @foldoutGroup(GROUP_BODY) windupLaunchAcceleration: number = 40;
  @foldoutGroup(GROUP_BODY) windupClearance: number = 0.02;
  @foldoutGroup(GROUP_BODY) windupSquash: number = 0.03;
  @foldoutGroup(GROUP_BODY) windupPitch: number = 1.5;

  // ---------- Park & Depart ----------

  /** MotionTuning.arriveBounceAmount / arriveBounceDuration. */
  @foldoutGroup(GROUP_PARK) arriveBounceAmount: number = 0.2;
  @foldoutGroup(GROUP_PARK) arriveBounceDuration: number = 0.25;
  /** MotionTuning.boardPopAmount / boardPopFrequency / boardPopDamping. */
  @foldoutGroup(GROUP_PARK) boardPopAmount: number = 0.1;
  @foldoutGroup(GROUP_PARK) boardPopFrequency: number = 6;
  @foldoutGroup(GROUP_PARK) boardPopDamping: number = 0.45;
  /** MotionTuning.fullPopAmount / fullPopDuration. */
  @foldoutGroup(GROUP_PARK) fullPopAmount: number = 0.18;
  @foldoutGroup(GROUP_PARK) fullPopDuration: number = 0.3;
  /** MotionTuning.departDelay (seconds, not divided by vehicleSpeedScale, as in Unity). */
  @foldoutGroup(GROUP_PARK) departDelay: number = 0.15;
  /** MotionTuning departure route and slot-clear values. */
  @foldoutGroup(GROUP_PARK) departRise: number = 0.45;
  @foldoutGroup(GROUP_PARK) departRun: number = 4.5;
  @foldoutGroup(GROUP_PARK) departTurnRadius: number = 0.3;
  @foldoutGroup(GROUP_PARK) slotClearDistance: number = 0.5;

  // ---------- Blocked Bounce (ImpactBounceCommand / ImpactShoveCommand) ----------

  /** MotionTuning.bounceLungeSpeed: speed cap while lunging into a blocker. */
  @foldoutGroup(GROUP_BOUNCE) bounceLungeSpeed: number = 12;
  /** MotionTuning.bounceLungeAcceleration, before vehicleSpeedScale^2. */
  @foldoutGroup(GROUP_BOUNCE) bounceLungeAcceleration: number = 150;
  /** MotionTuning.bounceMaxTravel: how far ahead to probe/lunge when nothing is actually hit. */
  @foldoutGroup(GROUP_BOUNCE) bounceMaxTravel: number = 8;
  /** MotionTuning.bounceContactGap: stop this short of the vehicle in front. */
  @foldoutGroup(GROUP_BOUNCE) bounceContactGap: number = 0.02;
  /** MotionTuning.bounceMinNudge / bounceMaxCompression: a tight gap becomes body compression. */
  @foldoutGroup(GROUP_BOUNCE) bounceMinNudge: number = 0.08;
  @foldoutGroup(GROUP_BOUNCE) bounceMaxCompression: number = 0.2;
  /** MotionTuning.bounceImpactPitch (degrees) / bounceImpactSquash / bounceImpactDuration. */
  @foldoutGroup(GROUP_BOUNCE) bounceImpactPitch: number = 7;
  @foldoutGroup(GROUP_BOUNCE) bounceImpactSquash: number = 0.06;
  @foldoutGroup(GROUP_BOUNCE) bounceImpactDuration: number = 0.15;
  /** MotionTuning.bounceReboundDistance: quick snap-back right after contact. */
  @foldoutGroup(GROUP_BOUNCE) bounceReboundDistance: number = 0.1;
  /** MotionTuning.bounceReboundDuration, before vehicleSpeedScale. */
  @foldoutGroup(GROUP_BOUNCE) bounceReboundDuration: number = 0.06;
  /** MotionTuning.bounceReturnSpeed: speed of the slower drift back to the start. */
  @foldoutGroup(GROUP_BOUNCE) bounceReturnSpeed: number = 5;
  /** MotionTuning.bounceReturnMinDuration. */
  @foldoutGroup(GROUP_BOUNCE) bounceReturnMinDuration: number = 0.08;
  /** MotionTuning.blockerShoveDistance: how far the struck vehicle gets pushed by the impact. */
  @foldoutGroup(GROUP_BOUNCE) blockerShoveDistance: number = 0.08;
  /** MotionTuning.blockerShoveTilt, degrees. */
  @foldoutGroup(GROUP_BOUNCE) blockerShoveTilt: number = 10;
  /** MotionTuning.blockerShoveDuration, before vehicleSpeedScale. */
  @foldoutGroup(GROUP_BOUNCE) blockerShoveDuration: number = 0.16;
  /** MotionTuning.blockerSwayDuration: how long the struck vehicle keeps rocking afterward. */
  @foldoutGroup(GROUP_BOUNCE) blockerSwayDuration: number = 0.9;
  /** MotionTuning.blockerSwayFrequency, Hz. */
  @foldoutGroup(GROUP_BOUNCE) blockerSwayFrequency: number = 2.5;
  /** MotionTuning.blockerSwayTilt, degrees. */
  @foldoutGroup(GROUP_BOUNCE) blockerSwayTilt: number = 7;
  /** MotionTuning.blockerSwayYaw, degrees. */
  @foldoutGroup(GROUP_BOUNCE) blockerSwayYaw: number = 3;
  /**
   * Not in Unity: two driving vehicles (to a slot or departing) whose bodies touch
   * play the hit VFX and both get the blocker shove, then keep driving.
   */
  @foldoutGroup(GROUP_BOUNCE) trafficBumpEnabled: boolean = true;
  /** Overlap (level units) the two bodies need before it counts as a bump. */
  @foldoutGroup(GROUP_BOUNCE) trafficBumpTolerance: number = 0.02;

  // Runtime state. Private number fields start with `_`: PiaEngine would otherwise
  // serialize (and show) them like any field with a plain default.
  private spawnedObjects: GameObject[] = [];
  private parkingManager: ParkingManager | null = null;
  private board: BoardRect = { minX: -3, maxX: 3, minZ: -3, maxZ: 3 };
  /** Scene units per Unity world unit (1 / Unity BoardScale). */
  private _unit = 1;
  /** Scene units per Unity world unit in the parking area (parked body ratio). */
  private _parkingUnit = 1;
  private activeDrives: VehicleDrive[] = [];
  private activeBounces: VehicleBounce[] = [];
  private activeShoves: VehicleShove[] = [];
  /** Pairs of driving vehicles currently touching (a bump fires once per contact). */
  private trafficContacts = new Set<string>();
  /** VehiclePopCommand per vehicle; a new pop replaces the running one. */
  private activePops: Map<Vehicle, VehiclePop> = new Map();
  /** Timeline delays (departDelay), on the vehicle clock. */
  private waits: { left: number; callback: () => void }[] = [];



  /**
   * Whole-level zoom. Applied per vehicle GameObject at spawn time (position *and* scale,
   * see initialize()) rather than on spawnRoot: Vehicle.applyScale() resets node.scale
   * from a `baseScale` it captures once from the GameObject's own local scale, so a shrink
   * inherited from a scaled parent is wiped out the moment any squash/pop/arrive-bounce
   * fires (constantly) — worse, parking reparents the GameObject to the (unscaled) slot
   * container, so it would render full-size again. Baking the scale into the GameObject
   * itself keeps it correct through all of that. Every level-unit distance/footprint
   * read off that same world position must shrink by the same factor to stay
   * self-consistent — see u()/p(), dimensionsOf() and the
   * footprintWidth/exitSweepLength/exitOverlapTolerance call sites.
   */
  @foldoutGroup(GROUP_VEHICLE) @field({ label: 'Kích thước xe', range: [0.1, 10], step: 0.1 }) vehicleScale: number = 1;

  onEnable(): void {
    EventBus.on(GameEvents.CAR_CLICK, this.onVehicleClicked);
  }

  onDisable(): void {
    EventBus.off(GameEvents.CAR_CLICK, this.onVehicleClicked);
  }

  /**
   * We may still hold a Vehicle reference (activeDrives/Bounces/Shoves) after its
   * GameObject was destroyed (Cocos: `vehicle.node !== null && vehicle.node.isValid`).
   */
  private vehicleObjectValid(vehicle: Vehicle): boolean {
    return isAlive(vehicle) && isAlive(vehicle.gameObject);
  }

  update(): void {
    const realDeltaTime = Time.deltaTime;
    // Vehicle tracks run on the pacing speed factor (PresentationTimeline.Tick(deltaTime, factor)).
    Pacing.advance(realDeltaTime);
    const deltaTime = realDeltaTime * Pacing.speed;
    this.updatePops(deltaTime);
    for (let i = this.waits.length - 1; i >= 0; i--) {
      const wait = this.waits[i];
      wait.left -= deltaTime;
      if (wait.left <= 0) {
        this.waits.splice(i, 1);
        wait.callback();
      }
    }
    for (let i = this.activeDrives.length - 1; i >= 0; i--) {
      const drive = this.activeDrives[i];
      if (!this.vehicleObjectValid(drive.vehicle)) {
        this.activeDrives.splice(i, 1);
        continue;
      }
      this.stepDrive(drive, deltaTime);
      if (drive.finished) {
        this.activeDrives.splice(i, 1);
        this.endDrive(drive);
        drive.onArrive();
      }
    }
    this.updateTrafficBumps();
    for (let i = this.activeBounces.length - 1; i >= 0; i--) {
      const bounce = this.activeBounces[i];
      if (!this.vehicleObjectValid(bounce.vehicle)) {
        this.activeBounces.splice(i, 1);
        continue;
      }
      if (this.stepBounce(bounce, deltaTime)) {
        this.activeBounces.splice(i, 1);
        bounce.vehicle.clearImpact(BOUNCE_LAYER);
        bounce.vehicle.setPose(bounce.origin, bounce.yaw);
        bounce.vehicle.isMoving = false;
      }
    }
    for (let i = this.activeShoves.length - 1; i >= 0; i--) {
      const shove = this.activeShoves[i];
      shove.elapsed += deltaTime;
      if (!this.vehicleObjectValid(shove.vehicle) || shove.elapsed >= Math.max(shove.shoveTime, shove.swayTime)) {
        this.activeShoves.splice(i, 1);
        if (this.vehicleObjectValid(shove.vehicle)) {
          shove.vehicle.clearImpact(SHOVE_LAYER);
        }
        continue;
      }
      this.applyShovePose(shove);
    }
    // PlayPresentation: every vehicle advances its board-pop spring each frame, and
    // (while still on the board) dims/brightens its direction mask with Rule C1.
    for (const go of this.spawnedObjects) {
      if (!isAlive(go)) {
        continue;
      }
      const vehicle = go.getComponent(Vehicle);
      if (vehicle === null) {
        continue;
      }
      vehicle.advanceBoardPop(deltaTime, this.boardPopAmount, this.boardPopFrequency, this.boardPopDamping);
      if (!vehicle.isMoving && !vehicle.isParked) {
        vehicle.setBlocked(!this.isExitClear(vehicle));
      }
    }
  }

  initialize(levelData: LevelData, parkingManager: ParkingManager | null = null): void {
    this.parkingManager = parkingManager;
    this.normalizeLegacySceneValues();
    this.setBoardBounds(levelData);
    this._unit = this.motionScaleOverride > 0 ? this.motionScaleOverride : 1 / this.unityBoardScale(levelData);
    this._parkingUnit = this.parkingScaleOverride > 0
      ? this.parkingScaleOverride
      : this.footprintWidth / Math.max(0.0001, this.unityParkedVehicleWidth);
    this.clearSpawnedVehicles();

    for (const vehicleData of levelData.cars) {
      const kind = this.resolveKind(vehicleData);
      if (kind === null) {
        Debug.error(
          `[VehicleManager] Vehicle id=${vehicleData.id} has unsupported seats=${vehicleData.seats}. `
          + 'Expected 16 (car), 24 (van), or 40 (bus); alternatively set kind to car, van, or bus.',
        );
        continue;
      }

      const prefab = this.prefabFor(kind);
      if (prefab === null) {
        Debug.error(`[VehicleManager] ${kind}Prefab is not assigned; cannot spawn vehicle id=${vehicleData.id}.`);
        continue;
      }

      const go = this.instantiate(prefab, (this.spawnRoot ?? this.gameObject).transform);
      // GD stores [x, y] with +Y at the top. The Cocos camera has screen-up
      // toward world -Z, so source Y maps to -Z. Positions are pre-scaled by
      // vehicleScale here (not via a scaled parent, see vehicleScale doc comment)
      // so spacing shrinks together with each vehicle's own size.
      go.transform.setLocalPosition(vehicleData.pos.x * this.vehicleScale, this.yOffset, -vehicleData.pos.y * this.vehicleScale);
      go.transform.setLocalEulerAngles(0, 90 - vehicleData.rot_y, 0);
      go.transform.setLocalScale(this.vehicleScale, this.vehicleScale, this.vehicleScale);

      const vehicle = go.getComponent(Vehicle) ?? go.addComponent(Vehicle);
      vehicle.initialize(vehicleData, kind);
      this.spawnedObjects.push(go);
    }
  }

  /** Scene units per Unity world unit; BeltManager and others can share it. */
  public get motionUnit(): number {
    return this._unit;
  }

  private onVehicleClicked = (vehicle: Vehicle): void => {
    // CAR_CLICK is global; ignore a vehicle that was not created by this manager.
    if (!this.spawnedObjects.includes(vehicle.gameObject) || vehicle.isMoving || vehicle.isParked) {
      return;
    }
    if (this.parkingManager === null) {
      Debug.error('[VehicleManager] ParkingManager is missing; cannot park the selected vehicle.');
      return;
    }

    const slot = this.parkingManager.firstFreeSlot();
    if (slot === null) {
      if (EDITOR) {
        Debug.log('[VehicleManager] No free parking slot.');
      }
      // TODO(AudioManager): AudioManager.instance.playOneShot('Failed');
      this.playBlockedFeedback(vehicle);
      return;
    }

    const route = this.buildParkingRoute(vehicle, slot.transform.position);
    if (route === null) {
      this.playBounceFeedback(vehicle, this.forwardOf(vehicle));
      return;
    }

    const slotParent = slot.transform.parent;
    if (slotParent === null) {
      Debug.error('[VehicleManager] The selected parking slot has no parent.');
      return;
    }
    if (!this.parkingManager.tryClaimSlot(slot, vehicle.gameObject)) {
      // Defensive only: a slot is claimed synchronously, but never drive
      // toward it if another action claimed it first.
      this.playBlockedFeedback(vehicle);
      return;
    }

    vehicle.isMoving = true;
    vehicle.leftBoard = true;
    Pacing.vehicleParked = true;
    Pacing.boardCleared = this.spawnedObjects.every((go) => !isAlive(go) || go.getComponent(Vehicle)?.leftBoard !== false);
    // Both route targets become local to the slots' container. Keeping the
    // world transform prevents a snap when changing parent.
    vehicle.transform.setParent(slotParent, true);
    this.beginDrive(vehicle, route, () => {
      if (!this.vehicleObjectValid(vehicle)) {
        return;
      }
      vehicle.isMoving = false;
      vehicle.isParked = true;
      vehicle.setMaskVisible(false);
      // VehicleParkedPresenter: the parked marker is reached after the arrive bounce.
      EventBus.emit(GameEvents.VEHICLE_PARKED, vehicle, slot);
    }, { windup: true, arriveBounce: true });
    EventBus.emit(GameEvents.VEHICLE_MOVE_START, vehicle, this.dimensionsOf(vehicle).length / 2);
  };

  /**
   * VehicleDepartedPresenter: full pop, wait the rest of departDelay, leave the
   * bay (slot frees once the body travelled slotClearDistance), then retire the view.
   */
  public departVehicle(vehicle: Vehicle, slot: Slot, onComplete?: () => void): boolean {
    if (!this.vehicleObjectValid(vehicle) || !this.spawnedObjects.includes(vehicle.gameObject)
      || vehicle.isMoving || !vehicle.isParked || this.parkingManager === null
      || !slot.isClaimedBy(vehicle.gameObject)) {
      return false;
    }

    vehicle.isMoving = true;
    const startDeparture = (): void => {
      if (!this.vehicleObjectValid(vehicle) || this.parkingManager === null) {
        return;
      }
      // VehiclePlacementCommand(Departing): the slot count label goes away as the leg starts.
      slot.hideCount();

      const route = this.buildDepartureRoute(vehicle, slot);
      let released = false;
      const releaseSlot = (): void => {
        if (!released && this.parkingManager !== null) {
          released = this.parkingManager.releaseSlot(slot, vehicle.gameObject);
        }
      };
      const finish = (): void => {
        if (!this.vehicleObjectValid(vehicle)) {
          return;
        }
        releaseSlot();
        vehicle.isMoving = false;
        vehicle.isParked = false;
        const index = this.spawnedObjects.indexOf(vehicle.gameObject);
        if (index >= 0) {
          this.spawnedObjects.splice(index, 1);
        }
        EventBus.emit(GameEvents.VEHICLE_DEPARTED, vehicle, slot);
        onComplete?.();
        this.destroy(vehicle.gameObject);
      };

      if (route.length === 0) {
        finish();
        return;
      }
      const clearDistance = this.p(this.slotClearDistance);
      this.beginDrive(vehicle, route, finish, {
        keepSpeed: true,
        onProgress: (distance) => {
          if (distance >= clearDistance) {
            releaseSlot();
          }
        },
      });
    };

    const scale = Math.max(0.0001, this.vehicleSpeedScale);
    let waitAfterPop = this.departDelay;
    if (this.fullPopAmount > 0 && this.fullPopDuration > 0) {
      waitAfterPop = Math.max(0, this.departDelay - this.fullPopDuration / scale);
      this.playVehiclePop(vehicle, this.fullPopAmount, this.fullPopDuration / scale, () => this.waitThen(waitAfterPop, startDeparture));
    } else {
      this.waitThen(waitAfterPop, startDeparture);
    }
    return true;
  }

  /** Body size of a vehicle in scene units (also used for boarding points), incl. vehicleScale. */
  public dimensionsOf(vehicle: Vehicle): VehicleDimensions {
    // Lengths: busgo-unity-2 vehicleLengthWBySeats. Widths: visual estimate of the meshes.
    let length: number;
    let width: number;
    switch (vehicle.data?.seats) {
      case 40: length = this.lengthOfSeats(40); width = 1.25; break;
      case 24: length = this.lengthOfSeats(24); width = 1.1; break;
      default: length = this.lengthOfSeats(16); width = 1.0; break;
    }
    return { length: length * this.vehicleScale, width: width * this.vehicleScale };
  }

  private waitThen(seconds: number, callback: () => void): void {
    if (seconds <= 0) {
      callback();
    } else {
      this.waits.push({ left: seconds, callback });
    }
  }

  /**
   * VehiclePopCommand: squash the body in place along Unity's punchShape
   * (positive = wider and lower). `duration` is already divided by
   * vehicleSpeedScale by the caller.
   */
  private playVehiclePop(vehicle: Vehicle, amount: number, duration: number, onComplete: (() => void) | undefined): void {
    if (amount <= 0 || duration <= 0) {
      vehicle.setSquash(0);
      onComplete?.();
      return;
    }
    this.activePops.set(vehicle, { amount, duration, elapsed: 0, onComplete });
    vehicle.setSquash(0);
  }

  private updatePops(deltaTime: number): void {
    // Plain Map#forEach, not `for (const [k, v] of [...map])`: spreading a Map and
    // destructuring the entries built in the build's minified/down-leveled output
    // (fine in editor preview, which runs the untouched TS-compiled JS) — forEach
    // avoids that and is spec-safe to delete the current entry from mid-iteration.
    this.activePops.forEach((pop, vehicle) => {
      if (!this.vehicleObjectValid(vehicle)) {
        this.activePops.delete(vehicle);
        return;
      }
      pop.elapsed += deltaTime;
      if (pop.elapsed < pop.duration) {
        vehicle.setSquash(pop.amount * MotionCurves.punchShape.evaluate(pop.elapsed / pop.duration));
        return;
      }
      this.activePops.delete(vehicle);
      vehicle.setSquash(0);
      pop.onComplete?.();
    });
  }

  /**
   * FreeSpaceRoute.PlanDeparture for a reverse-parked vehicle (nose toward the
   * lane): drive out along the slot axis, quarter-turn onto the lane toward the
   * nearer screen edge, then continue `departRun` along the lane.
   */
  private buildDepartureRoute(vehicle: Vehicle, slot: Slot): MotionPoint[] {
    const start = vehicle.posePosition.clone();
    const slotPosition = slot.transform.position;
    const outward = this.outwardOf(slotPosition);
    const theta = this.slotTheta(slotPosition);

    // ShorterTurn: turn onto the lane the way that needs less angle; straight
    // slots (both alike) turn toward the nearer screen edge.
    const toLeft = Math.abs(this.deltaRadians(theta, Math.PI));
    const toRight = Math.abs(this.deltaRadians(theta, 0));
    let side = slotPosition.x >= (this.board.minX + this.board.maxX) / 2 ? 1 : -1;
    if (Math.abs(toLeft - toRight) > Math.PI / 180) {
      side = toLeft < toRight ? -1 : 1;
    }
    const laneDirection = new Vector3(side, 0, 0);
    const laneOffset = Math.max(0.01, this.p(this.parkingLaneOffset));
    const radius = Math.min(Math.max(0.01, this.p(this.departTurnRadius)), laneOffset);
    const run = this.p(this.departRun);

    const route: MotionPoint[] = [];
    const forward = this.forwardOf(vehicle);
    if (V3.dot(forward, outward) <= 0) {
      // Nose faces into the slot (should not happen with ReverseIn parking):
      // FreeSpaceRoute's departRise + turn fallback.
      const rise = V3.add(new Vector3(), start, V3.multiplyScalar(new Vector3(), outward, this.p(this.departRise)));
      this.appendReverseLine(route, start, rise, V3.multiplyScalar(new Vector3(), outward, -1));
      const laneEnd = V3.add(new Vector3(), rise, V3.multiplyScalar(new Vector3(), laneDirection, run));
      this.appendMotionLine(route, rise, laneEnd, false);
      return route;
    }

    // PlanDeparture, nose toward the lane: out along the slot axis, keep-radius arc onto the lane, departRun on.
    return this.virtualExit(start, theta, side > 0 ? 0 : Math.PI, radius, run, start.y);
  }

  /**
   * Older scenes serialized two invented values before the Unity asset values
   * were ported. Replace only those exact legacy numbers, so a deliberate
   * Inspector tweak is still respected.
   */
  private normalizeLegacySceneValues(): void {
    // StandardFreeSpaceRoute.lineOuterRingMargin.
    if (Math.abs(this.exitOvershoot - 0.8) < 0.0001) {
      this.exitOvershoot = 0.3;
    }
    // StandardFreeSpaceRoute.sampleSpacing.
    if (Math.abs(this.routeSampleSpacing - 0.08) < 0.0001) {
      this.routeSampleSpacing = 0.03;
    }
  }

  /**
   * SceneLayout.FitBounds / FitBoard: the scale Unity draws this level at.
   * Scene units are level units, so 1 / BoardScale converts Unity world values.
   */
  private unityBoardScale(levelData: LevelData): number {
    const cap = this.unityBoardMaxScale;
    if (levelData.bounds_W.x > 0 && levelData.bounds_W.y > 0) {
      const scale = Math.min(this.unityBoundsFitWidth / levelData.bounds_W.x, this.unityBoundsFitDepth / levelData.bounds_W.y);
      return Math.max(0.0001, Math.min(scale, cap));
    }
    // FitBoard: symmetric body envelope + boardMargin, first boardFitArea that holds it.
    let halfX = 0;
    let halfZ = 0;
    for (const car of levelData.cars) {
      const reach = (car.seats === 40 ? 2.5 : car.seats === 24 ? 2.0 : 1.6) / 2;
      halfX = Math.max(halfX, Math.abs(car.pos.x) + reach);
      halfZ = Math.max(halfZ, Math.abs(car.pos.y) + reach);
    }
    halfX += 0.15;
    halfZ += 0.15;
    const areas = [{ x: 3.98, y: 4.4 }, { x: 4.3, y: 4.78 }];
    let chosen = areas[areas.length - 1];
    for (const area of areas) {
      if (halfX <= area.x / 2 && halfZ <= area.y / 2) {
        chosen = area;
        break;
      }
    }
    let scale = cap;
    if (halfX > 0) scale = Math.min(scale, chosen.x / 2 / halfX);
    if (halfZ > 0) scale = Math.min(scale, chosen.y / 2 / halfZ);
    return Math.max(0.0001, scale);
  }

  /**
   * A Unity world-space distance (or speed / acceleration) in scene units, also
   * folding in vehicleScale (distance *and* speed, so driving still takes the same
   * time across the now-shorter, zoomed distance).
   */
  private u(value: number): number {
    return value * this._unit * this.vehicleScale;
  }

  /** A Unity world-space distance of the parking area in scene units, incl. vehicleScale. */
  private p(value: number): number {
    return value * this._parkingUnit * this.vehicleScale;
  }

  /**
   * Direct port of the visible Unity flow for a normal tap:
   *
   * 1. Exit straight ahead until the body clears the live board.
   * 2. Follow the outer ring to the parking lane.
   * 3. Drive past the slot, stop for a gear change, then reverse around the
   *    same quarter-circle used by FreeSpaceRoute.BuildParkingTemplate.
   *
   * Unity's full profile can additionally fall back to Hybrid A* for special
   * gimmick layouts. The standard playable layout uses this line approach.
   */
  private buildParkingRoute(vehicle: Vehicle, slotPosition: Readonly<Vector3>): MotionPoint[] | null {
    const start = vehicle.posePosition.clone();
    const forward = this.forwardOf(vehicle);

    const dimensions = this.dimensionsOf(vehicle);
    const overshoot = this.u(this.exitOvershoot);
    const liveBoard = this.activeBoardBounds(vehicle);
    const exitDistance = this.distanceToBoardEdge(start, forward, liveBoard)
      + dimensions.length / 2 + overshoot;
    if (!this.isExitClear(vehicle)) {
      if (EDITOR) {
        Debug.log(`[VehicleManager] Vehicle ${vehicle.data?.id ?? '?'} is blocked in front.`);
      }
      return null;
    }

    // Profile chuẩn: the BFP-style L route first; the ring route below only when no candidate is clear.
    const line = this.tryLineApproach(vehicle, slotPosition);
    if (line !== null) {
      return line;
    }

    const exit = V3.add(new Vector3(), start, V3.multiplyScalar(new Vector3(), forward, exitDistance));
    const perimeterMargin = dimensions.length / 2 + overshoot;
    const ring: BoardRect = {
      minX: liveBoard.minX - perimeterMargin,
      maxX: liveBoard.maxX + perimeterMargin,
      minZ: liveBoard.minZ - perimeterMargin,
      maxZ: liveBoard.maxZ + perimeterMargin,
    };
    const exitEdge = this.snapToEdge(ring, exit);

    // The parking row is outside the board. `outward` points from a parked
    // car back toward the board/lane (Unity's OutwardTheta: the slot axis,
    // perpendicular to the straight slot row).
    const outward = this.outwardOf(slotPosition);
    const parkingSide = V3.multiplyScalar(new Vector3(), outward, -1);
    const turnRadius = this.parkTurnRadius();

    // FreeSpaceRoute.ApproachSideOf: a car on the left of the slot reaches the
    // lane moving right, and vice versa; within the deadband the nose decides.
    const dx = slotPosition.x - start.x;
    const approachSign = Math.abs(dx) > this.u(this.approachSideDeadband) ? Math.sign(dx) : (Math.sign(forward.x) || 1);
    const goal = this.lineGoal(slotPosition, approachSign, start.y);
    const laneDirection = goal.laneDirection;
    const staging = goal.staging;
    const laneLead = Math.max(dimensions.length, turnRadius * 2 + this.u(0.2));
    const laneJoin = V3.subtract(new Vector3(), staging, V3.multiplyScalar(new Vector3(), laneDirection, laneLead));
    const parkingEntry = this.pointOnPerimeterFacing(ring, laneJoin, parkingSide, start.y);

    const rawApproach: Vector3[] = [start, exit, exitEdge];
    this.addShortestPerimeterPath(rawApproach, ring, exitEdge, parkingEntry, start.y);
    rawApproach.push(laneJoin, staging);

    const route = this.sampleRoundedForwardRoute(rawApproach, this.u(this.lineCornerRadius));
    // ReverseIn template: staging -> back along the lane -> arc -> along the slot axis into the slot.
    this.appendTemplate(route, goal.template);
    return route;
  }

  // ---------- Line approach (FreeSpaceRoute.TryLineApproach) ----------
  //
  // Keeps the nose heading out of the board, drives forward only, and rounds every
  // corner with an arc (widest that fits). Candidates: (a) straight to the lane then
  // into it; (d) turn early up to the lane, square or diagonal toward the slot;
  // (e) turn early out to a side column then up; (b) leave through a side edge of
  // the board frame and follow that column; (c) leave through the far edge, follow
  // the far row to a column, then up. All corners turn the same way (no S). The
  // shortest candidate that touches no board vehicle and no parked vehicle wins,
  // over both sides of the slot. No candidate: the ring route is the fallback.

  private tryLineApproach(vehicle: Vehicle, slotPosition: Readonly<Vector3>): MotionPoint[] | null {
    const start = vehicle.posePosition.clone();
    const self = this.footprintOf(vehicle);
    const search: LineSearch = {
      start,
      forward: this.forwardOf(vehicle),
      self,
      obstacles: [],
      parked: [],
      best: Number.POSITIVE_INFINITY,
      plan: null,
      goal: null,
      checks: 0,
    };
    for (const go of this.spawnedObjects) {
      const other = isAlive(go) ? go.getComponent(Vehicle) : null;
      if (other === null || other === vehicle) {
        continue;
      }
      const body = this.footprintOf(other);
      if (!other.leftBoard) {
        // Start relief: a body already touching the start pose cannot veto every candidate.
        if (!this.footprintsOverlap(self, body, 0)) {
          search.obstacles.push(body);
        }
      } else if (other.isParked && !other.isMoving) {
        // ParkedBodies: vehicles standing in a slot. A departing vehicle is driving away, not parked.
        search.parked.push(body);
      }
    }

    for (const direction of [-1, 1]) {
      this.tryLineGoal(search, this.lineGoal(slotPosition, direction, start.y));
    }
    if (search.plan === null || search.goal === null) {
      return null;
    }
    const route = search.plan.route;
    this.appendTemplate(route, search.goal.template);
    return route;
  }

  /** FreeSpaceRoute.TryLineGoal: candidates (a), (d), (e), (b), (c) toward one staging pose. */
  private tryLineGoal(search: LineSearch, goal: LineGoal): void {
    // AudioManager.instance.playOneShot('Go')
    const MinLaneSlope = 0.05;
    const OnEdge = 1e-4;
    const from = search.start;
    const heading = search.forward;
    const to = goal.staging;
    const laneZ = to.z;
    const board = this.lineBoard(search.obstacles, from);
    const up = laneZ >= (board.minZ + board.maxZ) / 2 ? 1 : -1;
    const startTheta = Math.atan2(heading.z, heading.x);
    const endTheta = Math.atan2(goal.laneDirection.z, goal.laneDirection.x);
    const y = from.y;
    const point = (x: number, z: number): Vector3 => new Vector3(x, y, z);
    const tryPoints = (points: Vector3[]): void => this.tryLineCandidate(search, goal, points, startTheta, endTheta);

    if (heading.z * up > MinLaneSlope) {
      // (a) The nose ray crosses the lane ahead.
      tryPoints([from, V3.scaleAndAdd(new Vector3(), from, heading, (laneZ - from.z) / heading.z), to]);
    }
    const laneDirection = goal.laneDirection.x >= 0 ? 1 : -1;
    const cornerRadius = this.u(this.lineCornerRadius);
    const inner = this.lineRing(board, 0, from, heading);
    const boardExit = this.distanceToBoardEdge(from, heading, inner);
    const step = Math.max(0.0001, this.u(this.lineTurnStep));
    const bestBeforeRun = search.best;
    for (let run = step; run < boardExit && run < search.best; run += step) {
      // (d) Turn early, square or diagonal toward the slot, once the way up is clear.
      const turn = V3.scaleAndAdd(new Vector3(), from, heading, run);
      tryPoints([from, turn, point(turn.x, laneZ), to]);
      tryPoints([from, turn, point(to.x - laneDirection * 2 * cornerRadius, laneZ), to]);
      // (e) Turn early out to a side column, then up.
      for (const x of [inner.minX, inner.maxX]) {
        tryPoints([from, turn, point(x, turn.z), point(x, laneZ), to]);
      }
      if (search.best < bestBeforeRun) {
        // The earliest turn that works wins; later turns are only longer.
        break;
      }
    }
    for (let pass = 0; pass < 2; pass++) {
      if (pass > 0 && Number.isFinite(search.best)) {
        // The outer ring is only a fallback when nothing else fits.
        break;
      }
      const ring = this.lineRing(board, pass === 0 ? 0 : this.u(this.exitOvershoot), from, heading);
      const exit = this.distanceToBoardEdge(from, heading, ring);
      if (exit <= 0) {
        continue;
      }
      const edge = V3.scaleAndAdd(new Vector3(), from, heading, exit);
      const farZ = up > 0 ? ring.minZ : ring.maxZ;
      if (Math.abs(edge.x - ring.minX) < OnEdge || Math.abs(edge.x - ring.maxX) < OnEdge) {
        // (b) Out through a side edge: follow that column up to the lane.
        tryPoints([from, edge, point(edge.x, laneZ), to]);
      } else if (Math.abs(edge.z - farZ) < OnEdge) {
        // (c) Out through the far edge: along the far row to a column, then up.
        for (const x of [ring.minX, ring.maxX]) {
          tryPoints([from, edge, point(x, farZ), point(x, laneZ), to]);
        }
      }
    }
  }

  /** FreeSpaceRoute.TryLineCandidate: widest corners first, shrinking by lineCornerRadiusFalloff. */
  private tryLineCandidate(search: LineSearch, goal: LineGoal, points: Vector3[], startTheta: number, endTheta: number): void {
    const minRadius = this.u(this.lineMinCornerRadius);
    const falloff = Math.min(0.99, Math.max(0.01, this.lineCornerRadiusFalloff));
    for (let radius = this.u(this.lineCornerRadius); radius >= minRadius - 1e-4; radius *= falloff) {
      const plan = this.buildFilletRoute(points, startTheta, endTheta, radius);
      if (plan === null) {
        continue;
      }
      if (plan.length >= search.best || search.checks >= this.lineMaxChecks) {
        return;
      }
      search.checks++;
      if (!this.isLineRouteClear(search, plan)) {
        continue;
      }
      search.best = plan.length;
      search.plan = plan;
      search.goal = goal;
      return;
    }
  }

  /**
   * FreeSpaceRoute.BuildFilletPath: the polyline with each corner rounded by its own
   * arc (up to maxRadius, shrunk when the edges are short, never below
   * lineMinCornerRadius); first edge along startTheta, last along endTheta with at
   * least lineFinalStraight left; every corner turns the same way. Angles are
   * atan2(z, x) on the XZ plane.
   */
  private buildFilletRoute(raw: readonly Vector3[], startTheta: number, endTheta: number, maxRadius: number): LinePlan | null {
    const points: Vector3[] = [];
    for (const p of raw) {
      const last = points[points.length - 1];
      if (last === undefined || (p.x - last.x) ** 2 + (p.z - last.z) ** 2 > 1e-8) {
        points.push(p);
      }
    }
    if (points.length < 2) {
      return null;
    }
    const edges = points.length - 1;
    const lengths: number[] = [];
    const headings: number[] = [];
    for (let i = 0; i < edges; i++) {
      const dx = points[i + 1].x - points[i].x;
      const dz = points[i + 1].z - points[i].z;
      lengths.push(Math.sqrt(dx * dx + dz * dz));
      headings.push(Math.atan2(dz, dx));
    }
    const aligned = Math.PI / 180;
    if (Math.abs(this.deltaRadians(startTheta, headings[0])) > aligned
      || Math.abs(this.deltaRadians(headings[edges - 1], endTheta)) > aligned) {
      return null;
    }
    const maxTurn = this.lineMaxCornerDegrees * Math.PI / 180;
    const turns: number[] = [0];
    for (let i = 1; i < edges; i++) {
      turns.push(this.deltaRadians(headings[i - 1], headings[i]));
      if (Math.abs(turns[i]) > maxTurn) {
        return null;
      }
      if (i > 1 && turns[i] * turns[i - 1] < 0) {
        // Two corners turning opposite ways (an S): never used.
        return null;
      }
    }
    const radii: number[] = [0];
    for (let i = 1; i < edges; i++) {
      radii.push(maxRadius);
    }
    const tangent = (corner: number): number =>
      corner <= 0 || corner >= edges ? 0 : radii[corner] * Math.tan(Math.abs(turns[corner]) / 2);
    const finalStraight = this.u(this.lineFinalStraight);
    for (let i = 0; i < edges; i++) {
      const need = tangent(i) + tangent(i + 1);
      const room = lengths[i] - (i === edges - 1 ? finalStraight : 0);
      if (room <= 0) {
        return null;
      }
      if (need > room) {
        const shrink = room / need;
        if (i > 0) radii[i] *= shrink;
        if (i + 1 < edges) radii[i + 1] *= shrink;
      }
    }
    const minRadius = this.u(this.lineMinCornerRadius);
    for (let i = 1; i < edges; i++) {
      if (radii[i] < minRadius - 1e-4) {
        return null;
      }
    }

    const route: MotionPoint[] = [];
    const position = points[0].clone();
    let theta = headings[0];
    let length = 0;
    let firstStraight = -1;
    for (let i = 0; i < edges; i++) {
      const straight = lengths[i] - tangent(i) - tangent(i + 1);
      if (straight > 1e-5) {
        const end = new Vector3(position.x + Math.cos(theta) * straight, position.y, position.z + Math.sin(theta) * straight);
        this.appendMotionLine(route, position, end, false);
        position.copy(end);
        length += straight;
      }
      if (firstStraight < 0) {
        firstStraight = length;
      }
      if (i + 1 < edges && Math.abs(turns[i + 1]) > 1e-4) {
        const turn = turns[i + 1];
        const radius = radii[i + 1];
        const sign = turn > 0 ? 1 : -1;
        const centre = new Vector3(position.x - Math.sin(theta) * radius * sign, position.y,
          position.z + Math.cos(theta) * radius * sign);
        const endTheta2 = theta + turn;
        const end = new Vector3(centre.x + Math.sin(endTheta2) * radius * sign, position.y,
          centre.z - Math.cos(endTheta2) * radius * sign);
        this.appendMotionArc(route, position, end, centre, sign, false);
        position.copy(end);
        theta = endTheta2;
        length += Math.abs(turn) * radius;
      }
    }
    return route.length > 0 ? { length, route, firstStraight } : null;
  }

  /**
   * IsPathClearOfObstacles + IsTurnClear + IsTemplateClearOfParked: the body never
   * overlaps a board vehicle (keeping `routeClearance` after the opening straight)
   * nor a parked vehicle.
   */
  private isLineRouteClear(search: LineSearch, plan: LinePlan): boolean {
    const spacing = Math.max(0.01, this.u(this.collisionCheckSpacing));
    const clearance = this.u(this.routeClearance);
    const parkedClearance = this.u(this.parkedClearance);
    const body: Footprint = { ...search.self };
    let travelled = 0;
    let sinceCheck = spacing;
    let previous = search.start;
    const route = plan.route;
    for (let i = 0; i < route.length; i++) {
      const point = route[i];
      const step = V3.distance(previous, point.position);
      travelled += step;
      sinceCheck += step;
      previous = point.position;
      if (sinceCheck < spacing && i < route.length - 1) {
        continue;
      }
      sinceCheck = 0;
      body.x = point.position.x;
      body.z = point.position.z;
      body.yaw = point.yaw;
      const margin = travelled > plan.firstStraight + 1e-4 ? clearance : 0;
      for (const obstacle of search.obstacles) {
        if (this.footprintsOverlap(body, obstacle, margin)) {
          return false;
        }
      }
      for (const parked of search.parked) {
        if (this.footprintsOverlap(body, parked, parkedClearance)) {
          return false;
        }
      }
    }
    return true;
  }

  /** FreeSpaceRoute.LineBoard: box around the bodies still on the board; empty board: the start point. */
  private lineBoard(obstacles: readonly Footprint[], from: Readonly<Vector3>): BoardRect {
    if (obstacles.length === 0) {
      return { minX: from.x, maxX: from.x, minZ: from.z, maxZ: from.z };
    }
    const rect: BoardRect = {
      minX: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      minZ: Number.POSITIVE_INFINITY,
      maxZ: Number.NEGATIVE_INFINITY,
    };
    for (const body of obstacles) {
      const radians = body.yaw * Math.PI / 180;
      const sin = Math.abs(Math.sin(radians));
      const cos = Math.abs(Math.cos(radians));
      const halfX = sin * body.halfLength + cos * body.halfWidth;
      const halfZ = cos * body.halfLength + sin * body.halfWidth;
      rect.minX = Math.min(rect.minX, body.x - halfX);
      rect.maxX = Math.max(rect.maxX, body.x + halfX);
      rect.minZ = Math.min(rect.minZ, body.z - halfZ);
      rect.maxZ = Math.max(rect.maxZ, body.z + halfZ);
    }
    return rect;
  }

  /**
   * FreeSpaceRoute.LineRing: the board frame grown by half the body width +
   * lineBoardMargin + extra, and holding the start plus lineMinCornerRadius ahead.
   */
  private lineRing(board: BoardRect, extra: number, from: Readonly<Vector3>, heading: Readonly<Vector3>): BoardRect {
    const margin = (this.footprintWidth * this.vehicleScale) / 2 + this.u(this.lineBoardMargin) + extra;
    const turn = V3.scaleAndAdd(new Vector3(), from, heading, this.u(this.lineMinCornerRadius));
    return {
      minX: Math.min(board.minX - margin, from.x, turn.x),
      maxX: Math.max(board.maxX + margin, from.x, turn.x),
      minZ: Math.min(board.minZ - margin, from.z, turn.z),
      maxZ: Math.max(board.maxZ + margin, from.z, turn.z),
    };
  }

  /**
   * FreeSpaceRoute.BuildParkingTemplate (ReverseIn, keepParkRadius): the staging pose
   * on the lane for a car travelling along `direction` (±1 on X), and the reverse-in
   * template from there into the (possibly slanted) slot.
   */
  private lineGoal(slotPosition: Readonly<Vector3>, direction: number, height: number): LineGoal {
    const laneHeading = direction >= 0 ? 0 : Math.PI;
    const exit = this.virtualExit(slotPosition, this.slotTheta(slotPosition), laneHeading, this.parkTurnRadius(),
      Math.max(0, this.p(this.parkingOverrun)), height);
    const staging = exit[exit.length - 1].position.clone();
    // Driving the virtual exit backwards: same body yaw at every point, reverse gear.
    const template = exit.slice(0, exit.length - 1).reverse().map((point) => ({ ...point, reverse: true }));
    return { staging, laneDirection: new Vector3(direction >= 0 ? 1 : -1, 0, 0), template };
  }

  /**
   * A virtual car leaving the slot along `theta` (atan2(z, x) on the XZ plane):
   * straight, then one arc of `radius` onto `laneHeading` ending on the lane
   * (AppendExitToLaneKeepingRadius), then `tail` straight along the lane. The
   * first point is the slot pose itself.
   */
  private virtualExit(
    slotPosition: Readonly<Vector3>, theta: number, laneHeading: number, radius: number, tail: number, height: number,
  ): MotionPoint[] {

    // TODO(AudioManager): AudioManager.instance.playOneShot('Go');

    const start = new Vector3(slotPosition.x, height, slotPosition.z);
    const route: MotionPoint[] = [{
      position: start.clone(),
      yaw: this.yawForVisualForward(new Vector3(Math.cos(theta), 0, Math.sin(theta))),
      reverse: false,
    }];
    const turn = this.deltaRadians(theta, laneHeading);
    const sign = turn >= 0 ? 1 : -1;
    // Z travelled by the arc per unit radius: integral of sin(theta) over the arc.
    const risePerRadius = sign * (Math.cos(theta) - Math.cos(theta + turn));
    const need = this.laneZ(slotPosition) - start.z;
    const sine = Math.sin(theta);
    const straight = Math.max(0, Math.abs(sine) > 1e-6 ? (need - radius * risePerRadius) / sine : 0);
    const position = start.clone();
    if (straight > 1e-5) {
      const end = new Vector3(position.x + Math.cos(theta) * straight, height, position.z + Math.sin(theta) * straight);
      this.appendMotionLine(route, position, end, false);
      position.copy(end);
    }
    if (Math.abs(turn) > 1e-6) {
      const centre = new Vector3(position.x - Math.sin(theta) * radius * sign, height, position.z + Math.cos(theta) * radius * sign);
      const end = new Vector3(centre.x + Math.sin(laneHeading) * radius * sign, height, centre.z - Math.cos(laneHeading) * radius * sign);
      this.appendMotionArc(route, position, end, centre, sign, false);
      position.copy(end);
    }
    if (tail > 1e-5) {
      const end = new Vector3(position.x + Math.cos(laneHeading) * tail, height, position.z + Math.sin(laneHeading) * tail);
      this.appendMotionLine(route, position, end, false);
    }
    return route;
  }

  /** Appends a reverse-in template (staging excluded, slot last). */
  private appendTemplate(route: MotionPoint[], template: readonly MotionPoint[]): void {
    for (const point of template) {
      this.appendMotionPoint(route, point.position, point.yaw, true);
    }
  }

  /** FreeSpaceRoute lane: laneOffsetZ from the slot row toward the board, measured on Z. */
  private laneZ(slotPosition: Readonly<Vector3>): number {
    return slotPosition.z + this.outwardOf(slotPosition).z * Math.max(0.01, this.p(this.parkingLaneOffset));
  }

  /** Unit vector on Z from the slot row toward the lane/board (the row's normal, not the slanted slot axis). */
  private outwardOf(slotPosition: Readonly<Vector3>): Vector3 {
    const boardCenterZ = (this.board.minZ + this.board.maxZ) / 2;
    return new Vector3(0, 0, boardCenterZ >= slotPosition.z ? 1 : -1);
  }

  /**
   * FreeSpaceRoute.OutwardTheta: the slot axis toward the lane, i.e. the row normal
   * rotated about +Y by ParkingManager.parkedYaw (world degrees, from the slot's
   * slotYaw). A parked car ends with exactly that yaw. Returned as atan2(z, x).
   */
  private slotTheta(slotPosition: Readonly<Vector3>): number {
    const side = this.outwardOf(slotPosition).z;
    const yaw = (this.parkingManager?.parkedYaw ?? 0) * Math.PI / 180;
    // Rotating (0, 0, side) about +Y by yaw gives (side * sin, 0, side * cos).
    return Math.atan2(side * Math.cos(yaw), side * Math.sin(yaw));
  }

  private parkTurnRadius(): number {
    const laneOffset = Math.max(0.01, this.p(this.parkingLaneOffset));
    return Math.min(Math.max(0.01, this.p(this.parkingTurnRadius)), laneOffset);
  }

  /** Rule body of a vehicle at its pose (length from the kind, width vehicleWidthW). */
  private footprintOf(vehicle: Vehicle): Footprint {
    return {
      x: vehicle.posePosition.x,
      z: vehicle.posePosition.z,
      yaw: vehicle.poseYaw - vehicle.driftYaw,
      halfLength: this.dimensionsOf(vehicle).length / 2,
      halfWidth: (this.footprintWidth * this.vehicleScale) / 2,
    };
  }

  /**
   * Separating-axis test of two oriented rectangles; `a` is grown by `clearance`.
   * Overlaps of `tolerance` or less count as touching, not overlapping (SeparatingAxis.Overlaps).
   */
  private footprintsOverlap(a: Footprint, b: Footprint, clearance: number, tolerance = 1e-4): boolean {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const reach = Math.hypot(a.halfLength + clearance, a.halfWidth + clearance) + Math.hypot(b.halfLength, b.halfWidth);
    if (dx * dx + dz * dz >= reach * reach) {
      return false;
    }
    const ra = a.yaw * Math.PI / 180;
    const rb = b.yaw * Math.PI / 180;
    // Length axis = nose (sin, cos); width axis perpendicular.
    const axes = [
      [Math.sin(ra), Math.cos(ra)], [Math.cos(ra), -Math.sin(ra)],
      [Math.sin(rb), Math.cos(rb)], [Math.cos(rb), -Math.sin(rb)],
    ];
    const aL = axes[0];
    const aW = axes[1];
    const bL = axes[2];
    const bW = axes[3];
    for (const [nx, nz] of axes) {
      const distance = Math.abs(dx * nx + dz * nz);
      const extentA = (a.halfLength + clearance) * Math.abs(aL[0] * nx + aL[1] * nz)
        + (a.halfWidth + clearance) * Math.abs(aW[0] * nx + aW[1] * nz);
      const extentB = b.halfLength * Math.abs(bL[0] * nx + bL[1] * nz)
        + b.halfWidth * Math.abs(bW[0] * nx + bW[1] * nz);
      if (distance >= extentA + extentB - tolerance) {
        return false;
      }
    }
    return true;
  }

  // ---------- Exit rule (StraightExitRule, `obbSweep`) ----------
  //
  // Rule geometry, not physics colliders: a strip footprintWidth * exitSweepWidth wide,
  // from the vehicle's rear (-length / 2) along its nose to exitSweepLength from the
  // centre. The vehicle is blocked when the strip overlaps the rule body (footprintWidth
  // x length) of another vehicle still on the board by more than exitOverlapTolerance.

  /** Rule bodies of the vehicles still on the board (logic `state.Board`), excluding `self`. */
  private boardFootprints(self: Vehicle | null): { vehicle: Vehicle; body: Footprint }[] {
    const bodies: { vehicle: Vehicle; body: Footprint }[] = [];
    for (const go of this.spawnedObjects) {
      const other = isAlive(go) ? go.getComponent(Vehicle) : null;
      if (other !== null && other !== self && !other.leftBoard) {
        bodies.push({ vehicle: other, body: this.footprintOf(other) });
      }
    }
    return bodies;
  }

  /** The exit strip of a rule body, as an oriented rectangle. */
  private exitSweepOf(body: Footprint): Footprint {
    const radians = body.yaw * Math.PI / 180;
    const from = -body.halfLength;
    const to = this.exitSweepLength * this.vehicleScale;
    const centre = (from + to) / 2;
    return {
      x: body.x + Math.sin(radians) * centre,
      z: body.z + Math.cos(radians) * centre,
      yaw: body.yaw,
      halfLength: (to - from) / 2,
      halfWidth: body.halfWidth * this.exitSweepWidth,
    };
  }

  /**
   * StraightExitRule.CollectBlockers + Nearest: the blocking bodies of `body`, nearest
   * first (projection on the nose, from the centre, of the blocker's nearest corner).
   */
  private exitBlockersOf<T>(body: Footprint, others: readonly { vehicle: T; body: Footprint }[]): { vehicle: T; body: Footprint; ahead: number }[] {
    const sweep = this.exitSweepOf(body);
    const radians = body.yaw * Math.PI / 180;
    const hx = Math.sin(radians);
    const hz = Math.cos(radians);
    const result: { vehicle: T; body: Footprint; ahead: number }[] = [];
    for (const other of others) {
      if (!this.footprintsOverlap(sweep, other.body, 0, this.exitOverlapTolerance * this.vehicleScale)) {
        continue;
      }
      let ahead = Number.POSITIVE_INFINITY;
      for (const corner of this.cornersOf(other.body)) {
        ahead = Math.min(ahead, (corner.x - body.x) * hx + (corner.z - body.z) * hz);
      }
      result.push({ vehicle: other.vehicle, body: other.body, ahead });
    }
    return result.sort((a, b) => a.ahead - b.ahead);
  }

  /** Rule C1: nothing on the board overlaps the vehicle's exit strip. */
  private isExitClear(vehicle: Vehicle): boolean {
    return this.exitBlockersOf(this.footprintOf(vehicle), this.boardFootprints(vehicle)).length === 0;
  }

  /** NoExitLoseRule: some vehicle still on the board can leave it (false on an empty board). */
  public hasExitableVehicle(): boolean {
    return this.boardFootprints(null).some((entry) => this.isExitClear(entry.vehicle));
  }

  /** A vehicle is driving, departing, bouncing or winding up. */
  public get hasMovingVehicle(): boolean {
    return this.activeDrives.length > 0 || this.activeBounces.length > 0 || this.activePops.size > 0
      || this.waits.length > 0
      || this.spawnedObjects.some((go) => isAlive(go) && go.getComponent(Vehicle)?.isMoving === true);
  }

  /**
   * FootprintGeometry.TimeOfImpact: how far `mover` can travel along `direction`
   * before touching `body`, up to `maxDistance` (Infinity when it never touches).
   */
  private timeOfImpact(mover: Footprint, direction: Readonly<Vector3>, body: Footprint, maxDistance: number): number {
    const moved: Footprint = { ...mover };
    const at = (distance: number): boolean => {
      moved.x = mover.x + direction.x * distance;
      moved.z = mover.z + direction.z * distance;
      return this.footprintsOverlap(moved, body, 0, 0);
    };
    if (at(0)) {
      return 0;
    }
    const step = 0.02;
    let clear = 0;
    let hit = -1;
    for (let distance = step; distance <= maxDistance + step; distance += step) {
      const d = Math.min(distance, maxDistance);
      if (at(d)) {
        hit = d;
        break;
      }
      clear = d;
      if (d >= maxDistance) {
        break;
      }
    }
    if (hit < 0) {
      return Number.POSITIVE_INFINITY;
    }
    for (let i = 0; i < 16; i++) {
      const mid = (clear + hit) / 2;
      if (at(mid)) {
        hit = mid;
      } else {
        clear = mid;
      }
    }
    return clear;
  }

  private cornersOf(body: Footprint): { x: number; z: number }[] {
    const radians = body.yaw * Math.PI / 180;
    const lx = Math.sin(radians) * body.halfLength;
    const lz = Math.cos(radians) * body.halfLength;
    const wx = Math.cos(radians) * body.halfWidth;
    const wz = -Math.sin(radians) * body.halfWidth;
    return [
      { x: body.x + lx + wx, z: body.z + lz + wz },
      { x: body.x + lx - wx, z: body.z + lz - wz },
      { x: body.x - lx - wx, z: body.z - lz - wz },
      { x: body.x - lx + wx, z: body.z - lz + wz },
    ];
  }

  // ---------- Exit gizmos ----------

  /**
   * Scene view: each board vehicle's rule body (yellow) and exit strip, green when it
   * can leave, red up to its nearest blocker otherwise (blocker outlined in red).
   * Runtime state while playing; LevelManager draws the selected level in edit mode.
   */
  onDrawGizmos(): void {
    Handles.label(this.transform.position, "VehicleManager")

    if (!this.drawExitGizmos || this.spawnedObjects.length === 0) {
      return;
    }

    const bodies = this.boardFootprints(null).map((entry) => ({ vehicle: entry.vehicle as unknown, body: entry.body }));
    this.drawExitGizmosFor(bodies, this.yOffset + 0.05);
  }

  /** Edit-mode preview of a level's exit rule, at the spawn transform. */
  public drawLevelExitGizmos(levelData: LevelData): void {
    if (!this.drawExitGizmos || this.spawnedObjects.length > 0) {
      return;
    }
    const root = (this.spawnRoot ?? this.gameObject).transform.position;
    const bodies = levelData.cars.map((car) => ({
      vehicle: car as unknown,
      body: {
        x: root.x + car.pos.x * this.vehicleScale,
        z: root.z - car.pos.y * this.vehicleScale,
        yaw: 90 - car.rot_y,
        halfLength: (this.lengthOfSeats(car.seats) * this.vehicleScale) / 2,
        halfWidth: (this.footprintWidth * this.vehicleScale) / 2,
      },
    }));
    this.drawExitGizmosFor(bodies, root.y + this.yOffset + 0.05);
  }

  private drawExitGizmosFor(bodies: { vehicle: unknown; body: Footprint }[], y: number): void {
    for (const entry of bodies) {
      const others = bodies.filter((other) => other !== entry);
      const blockers = this.exitBlockersOf(entry.body, others);
      Gizmos.color = GIZMO_YELLOW;
      this.drawFootprint(entry.body, y);
      const sweep = this.exitSweepOf(entry.body);
      const from = -entry.body.halfLength;
      const to = blockers.length > 0
        ? Math.max(from, blockers[0].ahead)
        : Math.min(this.exitSweepLength, this.gizmoSweepPreview) * this.vehicleScale;
      sweep.halfLength = (to - from) / 2;
      const radians = entry.body.yaw * Math.PI / 180;
      sweep.x = entry.body.x + Math.sin(radians) * (from + to) / 2;
      sweep.z = entry.body.z + Math.cos(radians) * (from + to) / 2;
      Gizmos.color = blockers.length > 0 ? GIZMO_RED : GIZMO_GREEN;
      this.drawFootprint(sweep, y + 0.01);
      if (blockers.length > 0) {
        this.drawFootprint({ ...blockers[0].body, halfWidth: blockers[0].body.halfWidth + 0.03, halfLength: blockers[0].body.halfLength + 0.03 }, y + 0.02);
      }
    }
  }

  private drawFootprint(body: Footprint, y: number): void {
    const points = this.cornersOf(body).map((corner) => new Vector3(corner.x, y, corner.z));
    Gizmos.drawLineStrip(points, true);
  }

  private lengthOfSeats(seats: number): number {
    switch (seats) {
      case 40: return 2.5;
      case 24: return 2.0;
      default: return 1.6;
    }
  }

  /** Shortest signed angle in radians, in (-PI, PI]. */
  private deltaRadians(from: number, to: number): number {
    let delta = (to - from) % (Math.PI * 2);
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta <= -Math.PI) delta += Math.PI * 2;
    return delta;
  }

  // ---------- Drive playback (PlaybackVehicleMotion / StandardVehicleDrive) ----------
  //
  // Unity plans the route once, builds a speed envelope along it (corner slowdown,
  // steer-rate limiting, accel/brake/launch ramps, cusp stops), then every tick
  // advances `distance` by the enveloped speed and reads position/yaw continuously
  // off the route at that distance. This mirrors that: `buildSpeedEnvelope` is
  // PlaybackDriveCommand.BuildProfile, `stepDrive` is its OnTick integration loop.

  private beginDrive(vehicle: Vehicle, route: MotionPoint[], onArrive: () => void, options: DriveOptions = {}): void {
    const anchored = this.anchorRouteStart(vehicle, route);
    const sampled = this.sampleRoute(anchored);
    if (sampled.length <= 0.0001) {
      onArrive();
      return;
    }
    const scale = this.vehicleSpeedScale;
    const windup = options.windup === true && this.windupDistance > 0 ? this.beginWindup(vehicle) : null;
    if (windup !== null && sampled.points.length > 1 && sampled.points[1].reverse) {
      // The route opens backwards: wind up, stop, then follow it.
      windup.exitSpeed = 0;
    }
    const startSpeed = windup !== null ? windup.exitSpeed : 0;
    const wheelbase = this.dimensionsOf(vehicle).length * this.wheelbaseRatio;
    const cusps = this.collectCusps(sampled);
    const keepSpeed = options.keepSpeed === true;
    const { envelope, curvatures, spacing } = this.buildSpeedEnvelope(sampled, cusps, wheelbase, !keepSpeed, startSpeed, windup !== null);
    const drive: VehicleDrive = {
      vehicle,
      sampled,
      envelope,
      curvatures,
      profileSpacing: spacing,
      cusps,
      nextCusp: 0,
      distance: 0,
      speed: 0,
      pauseLeft: 0,
      arrived: false,
      finished: false,
      keepSpeed,
      arriveBounce: options.arriveBounce === true && this.arriveBounceDuration / scale > 0,
      bounceElapsed: 0,
      roll: 0,
      pitch: 0,
      drift: 0,
      windup,
      coastPosition: vehicle.posePosition.clone(),
      coastYaw: vehicle.poseYaw - vehicle.driftYaw,
      onProgress: options.onProgress,
      onArrive,
    };
    this.activeDrives.push(drive);
    if (windup !== null) {
      this.windupPose(drive, 0);
    } else {
      this.applyDrivePose(drive, 0);
    }
  }

  // The route's sampled points never include the vehicle's exact current pose (each
  // appended segment starts one sample step past its `from`, see `appendMotionLine`),
  // so `pointAt(sampled, 0)` would land a small-to-large step away from where the
  // vehicle visually already is. Prepend the live pose so distance 0 means "here".
  private anchorRouteStart(vehicle: Vehicle, route: MotionPoint[]): MotionPoint[] {
    const start = vehicle.posePosition;
    const first = route[0];
    if (first !== undefined && V3.distance(start, first.position) <= 0.001) {
      return route;
    }
    const yaw = vehicle.poseYaw - vehicle.driftYaw;
    return [{ position: start.clone(), yaw, reverse: first?.reverse ?? false }, ...route];
  }

  private stepDrive(drive: VehicleDrive, deltaTime: number): void {
    const scale = this.vehicleSpeedScale;
    const windup = drive.windup;
    if (windup !== null && (windup.active || windup.squashing)) {
      windup.clock += deltaTime;
      this.applyWindupSquash(drive);
    }
    if (windup !== null && windup.active) {
      const total = windup.backTime + windup.launchTime;
      const now = Math.min(windup.clock, total);
      this.stepWindup(drive, now, now - Math.max(0, windup.clock - deltaTime));
      if (windup.clock < total) {
        return;
      }
      windup.active = false;
      drive.speed = windup.exitSpeed;
      deltaTime = windup.clock - total;
    }

    let remaining = deltaTime;
    if (!drive.arrived) {
      const acceleration = this.u(this.acceleration) * scale * scale;
      const minSpeed = this.u(this.driveMinSpeed) * scale;
      const step = this.driveIntegrationStep;
      const before = drive.speed;
      while (remaining > 0 && !drive.arrived) {
        const h = Math.min(remaining, step);
        remaining -= h;
        if (drive.pauseLeft > 0) {
          const used = Math.min(drive.pauseLeft, h);
          drive.pauseLeft -= used;
          remaining += h - used;
          continue;
        }
        // Follow the envelope; crawl at minSpeed so a flat stretch still reaches
        // the next stop in finite time.
        const limit = this.sampleEnvelope(drive.envelope, drive.profileSpacing, drive.distance);
        drive.speed = Math.max(
          Math.min(limit, drive.speed + acceleration * h),
          Math.min(minSpeed, drive.speed + acceleration * h),
        );
        const stop = drive.nextCusp < drive.cusps.length ? drive.cusps[drive.nextCusp] : drive.sampled.length;
        drive.distance += drive.speed * h;
        if (drive.distance >= stop) {
          // Unused time this tick (arrived at the stop mid-step) carries to the next step.
          const over = drive.speed > 0 ? (drive.distance - stop) / drive.speed : 0;
          remaining += Math.min(over, h);
          drive.distance = stop;
          if (drive.nextCusp < drive.cusps.length) {
            drive.nextCusp++;
            drive.speed = 0;
            drive.pauseLeft = this.gearChangePause / scale;
          } else {
            drive.arrived = true;
            if (!drive.keepSpeed) {
              drive.speed = 0;
            }
          }
        }
      }
      const elapsed = deltaTime - remaining;
      if (elapsed > 0) {
        this.updatePitch(drive, (drive.speed - before) / elapsed, elapsed);
      }
      this.applyDrivePose(drive, elapsed);
      drive.onProgress?.(drive.distance);
      if (!drive.arrived) {
        return;
      }
    }

    // Arrive bounce (approach leg): punchShape squash while lean and pitch settle.
    if (drive.arriveBounce) {
      const duration = this.arriveBounceDuration / scale;
      drive.bounceElapsed += remaining;
      this.applyDrivePose(drive, remaining);
      if (drive.bounceElapsed < duration) {
        drive.vehicle.setSquash(MotionCurves.punchShape.evaluate(drive.bounceElapsed / duration) * this.arriveBounceAmount);
        return;
      }
    }
    drive.finished = true;
  }

  /** PlaybackDriveCommand.OnEnd: release the squash; a stopped body levels out and drops its drift. */
  private endDrive(drive: VehicleDrive): void {
    const vehicle = drive.vehicle;
    vehicle.setSquash(0);
    if (drive.speed <= 0) {
      drive.roll = 0;
      drive.pitch = 0;
      drive.drift = 0;
      vehicle.driftYaw = 0;
      vehicle.setPose(
        this.pointAt(drive.sampled, drive.distance),
        this.yawAt(drive.sampled, drive.distance),
        0,
        0,
      );
    }
  }

  // ---------- Wind-up (PlaybackDriveCommand.BeginWindup / StepWindup) ----------

  /** Back-up depth: windupDistance, cut by the body behind (minus windupClearance). */
  private beginWindup(vehicle: Vehicle): DriveWindup {
    const scale = this.vehicleSpeedScale;
    const backward = V3.multiplyScalar(new Vector3(), this.forwardOf(vehicle), -1);
    const distance = this.u(this.windupDistance);
    const clearance = this.u(this.windupClearance);
    // FootprintGeometry.SweepContact: the body backing up against every body still on the board.
    const self = this.footprintOf(vehicle);
    let contact = Number.POSITIVE_INFINITY;
    for (const other of this.boardFootprints(vehicle)) {
      contact = Math.min(contact, this.timeOfImpact(self, backward, other.body, distance + clearance));
    }
    const depth = Number.isFinite(contact) ? this.clamp(contact - clearance, 0, distance) : distance;
    const acceleration = this.u(this.windupLaunchAcceleration) * scale * scale;
    const launchTime = depth > 0 ? Math.sqrt(2 * depth / acceleration) : 0;
    return {
      active: true,
      squashing: this.windupSquash > 0,
      clock: 0,
      depth,
      backTime: this.windupBackDuration / scale,
      launchTime,
      acceleration,
      exitSpeed: acceleration * launchTime,
    };
  }

  private stepWindup(drive: VehicleDrive, now: number, used: number): void {
    const windup = drive.windup!; // only called while a wind-up runs
    let offset: number;
    if (now < windup.backTime) {
      const k = smoothStep01(now / windup.backTime);
      offset = -windup.depth * k;
      drive.pitch = -this.windupPitch * k;
    } else {
      const launched = now - windup.backTime;
      offset = Math.min(0, -windup.depth + windup.acceleration * launched * launched / 2);
      if (used > 0) {
        this.updatePitch(drive, windup.acceleration, used);
      }
    }
    this.windupPose(drive, offset);
  }

  /** Pose along the body axis from the standing point (negative offset is backwards). */
  private windupPose(drive: VehicleDrive, offset: number): void {
    const radians = drive.coastYaw * Math.PI / 180;
    const position = new Vector3(
      drive.coastPosition.x + Math.sin(radians) * offset,
      drive.coastPosition.y,
      drive.coastPosition.z + Math.cos(radians) * offset,
    );
    drive.vehicle.driftYaw = 0;
    drive.vehicle.setPose(position, drive.coastYaw, 0, drive.pitch);
  }

  /** Smooth squash up to windupSquash at the deepest point, released over the same time. */
  private applyWindupSquash(drive: VehicleDrive): void {
    const windup = drive.windup!; // only called while a wind-up runs
    if (!windup.squashing) {
      return;
    }
    let k = windup.clock < windup.backTime
      ? smoothStep01(windup.clock / windup.backTime)
      : 1 - smoothStep01((windup.clock - windup.backTime) / windup.backTime);
    if (windup.clock >= 2 * windup.backTime) {
      windup.squashing = false;
      k = 0;
    }
    drive.vehicle.setSquash(this.windupSquash * k);
  }

  // ---------- Body pose (ApplyPose / UpdatePitch / UpdateDrift) ----------

  private gearAt(drive: VehicleDrive): number {
    return this.isReverseAt(drive.sampled, drive.distance) ? -1 : 1;
  }

  /** Longitudinal acceleration along the nose (normalized to speed scale 1 and Unity units) pitches the body. */
  private updatePitch(drive: VehicleDrive, longitudinal: number, elapsed: number): void {
    const scale = this.vehicleSpeedScale;
    const along = this.gearAt(drive) * longitudinal / (scale * scale) / this._unit;
    const target = this.clamp(-this.pitchPerLongitudinalAcceleration * along, -this.maxPitch, this.maxPitch);
    const response = this.pitchResponse > 0 ? this.pitchResponse : 0.0001;
    drive.pitch = this.lerp(drive.pitch, target, this.clamp((elapsed * scale) / response, 0, 1));
  }

  private applyDrivePose(drive: VehicleDrive, elapsed: number): void {
    const scale = this.vehicleSpeedScale;
    const position = this.pointAt(drive.sampled, drive.distance);
    const yaw = this.yawAt(drive.sampled, drive.distance);
    // Lateral acceleration of the body (speed^2 * curvature * gear), normalized to
    // speed scale 1 and Unity units; the body leans out of the turn.
    const curvature = this.sampleEnvelope(drive.curvatures, drive.profileSpacing, drive.distance);
    const lateral = (drive.speed * drive.speed * curvature * this.gearAt(drive)) / (scale * scale) / this._unit;
    // Axes: Unity is left-handed with screen-up +Z, Cocos right-handed with screen-up -Z.
    // Here yaw and curvature are measured natively in Cocos: a positive curvature turns
    // the nose toward local +X, which is the body's LEFT in a right-handed frame, and a
    // positive roll about local +Z moves the roof toward -X (the body's right). So the
    // body leans out of the turn with the same sign as Unity's formula.
    const target = this.clamp(this.cornerLeanPerLateralAcceleration * lateral, -this.cornerLeanMaxAngle, this.cornerLeanMaxAngle);
    const leanResponse = this.cornerLeanResponse > 0 ? this.cornerLeanResponse : 0.0001;
    drive.roll = this.lerp(drive.roll, drive.arrived ? 0 : target, this.clamp((elapsed * scale) / leanResponse, 0, 1));
    if (drive.arrived) {
      const pitchResponse = this.pitchResponse > 0 ? this.pitchResponse : 0.0001;
      drive.pitch = this.lerp(drive.pitch, 0, this.clamp((elapsed * scale) / pitchResponse, 0, 1));
    }
    this.updateDrift(drive, elapsed * scale, lateral);
    drive.vehicle.driftYaw = drive.drift;
    drive.vehicle.setPose(position, yaw + drive.drift, drive.roll, drive.pitch);
  }

  /** Tail drift: driving forward past driftLateralThreshold, the body turns a little further into the corner. */
  private updateDrift(drive: VehicleDrive, elapsed: number, lateral: number): void {
    let target = 0;
    const excess = Math.abs(lateral) - this.driftLateralThreshold;
    if (this.driftEnabled && !drive.arrived && this.gearAt(drive) > 0 && excess > 0) {
      target = Math.sign(lateral) * Math.min(this.driftMaxAngle, excess * this.driftAnglePerLateralAcceleration);
    }
    const growing = Math.abs(target) > Math.abs(drive.drift)
      && (drive.drift === 0 || Math.sign(target) === Math.sign(drive.drift));
    const response = growing ? this.driftResponse : this.driftRecovery;
    drive.drift = response <= 0 ? 0 : this.lerp(drive.drift, target, this.clamp(elapsed / response, 0, 1));
  }

  private sampleRoute(points: MotionPoint[]): SampledRoute {
    const distances: number[] = [0];
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      total += V3.distance(points[i - 1].position, points[i].position);
      distances.push(total);
    }
    return { points, distances, length: total };
  }

  /** FreeSpaceRoute points where the travel direction flips (approach -> reverse-in). */
  private collectCusps(sampled: SampledRoute): number[] {
    const cusps: number[] = [];
    const { points, distances } = sampled;
    for (let i = 1; i < points.length - 1; i++) {
      if (points[i].reverse !== points[i + 1].reverse) {
        cusps.push(distances[i]);
      }
    }
    return cusps;
  }

  private bracket(sampled: SampledRoute, s: number): { i: number; j: number; t: number } {
    const { distances, length } = sampled;
    const clamped = this.clamp(s, 0, length);
    let i = 0;
    while (i < distances.length - 2 && distances[i + 1] < clamped) {
      i++;
    }
    const j = Math.min(i + 1, distances.length - 1);
    const span = distances[j] - distances[i];
    const t = span > 0.0001 ? (clamped - distances[i]) / span : 0;
    return { i, j, t };
  }

  private pointAt(sampled: SampledRoute, s: number): Vector3 {
    const { i, j, t } = this.bracket(sampled, s);
    return V3.lerp(new Vector3(), sampled.points[i].position, sampled.points[j].position, t);
  }

  private yawAt(sampled: SampledRoute, s: number): number {
    const { i, j, t } = this.bracket(sampled, s);
    return this.lerpAngle(sampled.points[i].yaw, sampled.points[j].yaw, t);
  }

  private isReverseAt(sampled: SampledRoute, s: number): boolean {
    const { i } = this.bracket(sampled, s);
    return sampled.points[i].reverse;
  }

  private lerpAngle(from: number, to: number, t: number): number {
    return from + this.deltaAngle(from, to) * t;
  }

  /** Shortest signed angle from `from` to `to`, in (-180, 180]. */
  private deltaAngle(from: number, to: number): number {
    let delta = (to - from) % 360;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    return delta;
  }

  // ---------- Speed envelope (PlaybackDriveCommand.BuildProfile) ----------

  private buildSpeedEnvelope(
    sampled: SampledRoute, cusps: number[], wheelbase: number, stopAtEnd: boolean, startSpeed: number, woundUp: boolean,
  ): { envelope: number[]; curvatures: number[]; spacing: number } {
    const scale = this.vehicleSpeedScale;
    const length = sampled.length;
    const profileSpacing = this.u(this.driveProfileSpacing);
    const count = Math.max(2, Math.ceil(length / profileSpacing) + 1);
    const spacing = length / (count - 1);
    const half = spacing > 0 ? spacing : profileSpacing;
    const lateralLimit = this.u(this.lateralAcceleration) * scale * scale;

    const curvatures: number[] = [];
    const envelope: number[] = [];
    for (let i = 0; i < count; i++) {
      const s = spacing * i;
      const back = Math.max(0, s - half);
      const ahead = Math.min(length, s + half);
      const span = ahead - back;
      const turn = this.deltaAngle(this.yawAt(sampled, back), this.yawAt(sampled, ahead)) * (Math.PI / 180);
      const curvature = span > 0 ? turn / span : 0;
      curvatures.push(curvature);

      const reverseHere = this.isReverseAt(sampled, Math.min(length, s + spacing / 2));
      let limit = this.u(reverseHere ? this.reverseSpeed : this.cruiseSpeed) * scale;
      const absolute = Math.abs(curvature);
      if (absolute > 0) {
        limit = Math.min(limit, Math.sqrt(lateralLimit / absolute));
      }
      envelope.push(limit);
    }

    this.limitBySteerRate(sampled, envelope, curvatures, spacing, wheelbase, scale);
    this.holdMinimum(envelope, spacing);

    const deceleration = this.u(this.deceleration) * scale * scale;
    this.brake(envelope, cusps, spacing, deceleration, stopAtEnd);

    const acceleration = this.u(this.acceleration) * scale * scale;
    const launch = this.u(this.launchAcceleration) * scale * scale;
    this.accelerate(envelope, cusps, spacing, acceleration, launch, startSpeed, woundUp);

    this.roundPeaks(envelope, spacing);

    return { envelope, curvatures, spacing };
  }

  // Steer angle reference atan(wheelbase * curvature) changes by up to maxSteerRate within
  // steerTransitionDistance around a turn-in/out point; cap speed so the wheel can keep up.
  private limitBySteerRate(
    sampled: SampledRoute, envelope: number[], curvatures: number[],
    spacing: number, wheelbase: number, scale: number,
  ): void {
    const rate = this.maxSteerRate * (Math.PI / 180) * scale;
    const window = this.u(this.steerTransitionDistance);
    const reach = spacing > 0 ? Math.max(1, Math.ceil(window / spacing)) : 0;
    const count = curvatures.length;
    const length = sampled.length;
    const steerReference: number[] = [];
    for (let i = 0; i < count; i++) {
      const sign = this.isReverseAt(sampled, Math.min(length, spacing * i + spacing / 2)) ? -1 : 1;
      steerReference.push(Math.atan(sign * wheelbase * curvatures[i]));
    }
    for (let i = 0; i < count; i++) {
      let change = 0;
      for (let j = Math.max(0, i - reach); j <= Math.min(count - 1, i + reach); j++) {
        change = Math.max(change, Math.abs(steerReference[j] - steerReference[i]));
      }
      if (change > 0) {
        envelope[i] = Math.min(envelope[i], (rate * window) / change);
      }
    }
  }

  /** Each sample takes the lowest ceiling within +-slowdownHoldDistance (slow before a turn, stay slow through it). */
  private holdMinimum(envelope: number[], spacing: number): void {
    const reach = spacing > 0 ? Math.ceil(this.u(this.slowdownHoldDistance) / spacing) : 0;
    if (reach <= 0) {
      return;
    }
    const scratch = envelope.map((_, i) => {
      let least = envelope[i];
      for (let j = Math.max(0, i - reach); j <= Math.min(envelope.length - 1, i + reach); j++) {
        least = Math.min(least, envelope[j]);
      }
      return least;
    });
    scratch.forEach((value, i) => { envelope[i] = value; });
  }

  /** Brakes backward so the vehicle stops exactly at each cusp, and at the route end unless it keeps its speed. */
  private brake(envelope: number[], cusps: number[], spacing: number, deceleration: number, stopAtEnd: boolean): void {
    const last = envelope.length - 1;
    if (stopAtEnd) {
      envelope[last] = 0;
    }
    let cusp = cusps.length - 1;
    for (let i = last - 1; i >= 0; i--) {
      const s = spacing * i;
      const next = envelope[i + 1];
      let reach = Math.sqrt(next * next + 2 * deceleration * spacing);
      while (cusp >= 0 && cusps[cusp] > s + spacing) {
        cusp--;
      }
      if (cusp >= 0 && cusps[cusp] > s && cusps[cusp] <= s + spacing) {
        reach = Math.sqrt(2 * deceleration * (cusps[cusp] - s));
      }
      envelope[i] = Math.min(envelope[i], reach);
    }
  }

  /**
   * Accelerates forward from the start speed and every cusp. From a standstill the
   * first launchDistance uses the soft `launch` rate; after a wind-up it does not.
   */
  private accelerate(
    envelope: number[], cusps: number[], spacing: number, acceleration: number, launch: number,
    startSpeed: number, woundUp: boolean,
  ): void {
    const count = envelope.length;
    envelope[0] = Math.min(envelope[0], Math.max(0, startSpeed));
    const launchDistance = this.u(this.launchDistance);
    let launchFrom = startSpeed > 0 || woundUp ? Number.NEGATIVE_INFINITY : 0;
    let cusp = 0;
    for (let i = 1; i < count; i++) {
      const s = spacing * i;
      const previous = s - spacing;
      while (cusp < cusps.length && cusps[cusp] <= previous) {
        cusp++;
      }
      let reach: number;
      if (cusp < cusps.length && cusps[cusp] <= s) {
        launchFrom = cusps[cusp];
        reach = this.launchSpeed(s - launchFrom, acceleration, launch, launchDistance);
      } else if (s - launchFrom < launchDistance) {
        reach = Math.min(
          this.launchSpeed(s - launchFrom, acceleration, launch, launchDistance),
          Math.sqrt(envelope[i - 1] * envelope[i - 1] + 2 * acceleration * spacing),
        );
      } else {
        reach = Math.sqrt(envelope[i - 1] * envelope[i - 1] + 2 * acceleration * spacing);
      }
      envelope[i] = Math.min(envelope[i], reach);
    }
  }

  private launchSpeed(travelled: number, acceleration: number, launch: number, launchDistance: number): number {
    if (launchDistance <= 0) {
      return Math.sqrt(2 * acceleration * Math.max(0, travelled));
    }
    const soft = Math.min(Math.max(0, travelled), launchDistance);
    return Math.sqrt(2 * launch * soft + 2 * acceleration * Math.max(0, travelled - launchDistance));
  }

  /** Rounds speed peaks with a +-peakSmoothingDistance moving average (only ever lowers the cap). */
  private roundPeaks(envelope: number[], spacing: number): void {
    const reach = spacing > 0 ? Math.round(this.u(this.peakSmoothingDistance) / spacing) : 0;
    if (reach <= 0) {
      return;
    }
    const scratch = envelope.map((_, i) => {
      let sum = 0;
      let n = 0;
      for (let j = Math.max(0, i - reach); j <= Math.min(envelope.length - 1, i + reach); j++) {
        sum += envelope[j];
        n++;
      }
      return Math.min(envelope[i], sum / n);
    });
    scratch.forEach((value, i) => { envelope[i] = value; });
  }

  private sampleEnvelope(envelope: number[], spacing: number, s: number): number {
    if (envelope.length === 0) {
      return 0;
    }
    if (spacing <= 0) {
      return envelope[0];
    }
    const index = s / spacing;
    const i = this.clamp(Math.floor(index), 0, envelope.length - 1);
    const j = Math.min(i + 1, envelope.length - 1);
    return envelope[i] + (envelope[j] - envelope[i]) * (index - i);
  }

  /** Unity's LineBoard is the bounding box of vehicles still on the board. */
  private activeBoardBounds(excluding: Vehicle): BoardRect {
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (const go of this.spawnedObjects) {
      const vehicle = go.getComponent(Vehicle);
      // Only vehicles still on the board: one already tapped (driving to its slot,
      // parked or departing) must not stretch the frame up to the parking row.
      if (vehicle === null || vehicle === excluding || vehicle.leftBoard || !isAlive(go)) {
        continue;
      }
      const dimensions = this.dimensionsOf(vehicle);
      const position = vehicle.posePosition;
      // The axis-aligned envelope is intentionally conservative. It is
      // equivalent to Unity's LineBoard for the 0/90-degree level data.
      const halfExtent = dimensions.length / 2;
      minX = Math.min(minX, position.x - halfExtent);
      maxX = Math.max(maxX, position.x + halfExtent);
      minZ = Math.min(minZ, position.z - halfExtent);
      maxZ = Math.max(maxZ, position.z + halfExtent);
    }
    if (!Number.isFinite(minX)) {
      return { ...this.board };
    }
    return { minX, maxX, minZ, maxZ };
  }

  /** Point on the side of `rect` which faces the parking row. */
  private pointOnPerimeterFacing(rect: BoardRect, target: Readonly<Vector3>, side: Readonly<Vector3>, height: number): Vector3 {
    if (Math.abs(side.z) >= Math.abs(side.x)) {
      return new Vector3(
        this.clamp(target.x, rect.minX, rect.maxX),
        height,
        side.z >= 0 ? rect.maxZ : rect.minZ,
      );
    }
    return new Vector3(
      side.x >= 0 ? rect.maxX : rect.minX,
      height,
      this.clamp(target.z, rect.minZ, rect.maxZ),
    );
  }

  /** Samples Unity's `lineApproach` fillets as straight lines and circular arcs. */
  private sampleRoundedForwardRoute(raw: readonly Vector3[], requestedRadius: number): MotionPoint[] {
    const points = this.removeDuplicatePoints([...raw], raw[0]);
    if (points.length === 0) {
      return [];
    }

    const route: MotionPoint[] = [];
    let runStart = points[0];
    const radius = Math.max(0.001, requestedRadius);
    for (let index = 1; index < points.length - 1; index++) {
      const previous = points[index - 1];
      const corner = points[index];
      const next = points[index + 1];
      const incoming = V3.subtract(new Vector3(), corner, previous);
      const outgoing = V3.subtract(new Vector3(), next, corner);
      incoming.y = 0;
      outgoing.y = 0;
      const incomingLength = incoming.magnitude;
      const outgoingLength = outgoing.magnitude;
      if (incomingLength <= 0.001 || outgoingLength <= 0.001) {
        continue;
      }
      V3.multiplyScalar(incoming, incoming, 1 / incomingLength);
      V3.multiplyScalar(outgoing, outgoing, 1 / outgoingLength);
      const dot = this.clamp(V3.dot(incoming, outgoing), -1, 1);
      const cross = incoming.x * outgoing.z - incoming.z * outgoing.x;
      const angle = Math.acos(dot);
      const tangentScale = Math.tan(angle / 2);
      if (Math.abs(cross) <= 0.001 || tangentScale <= 0.001 || dot < -0.98) {
        this.appendMotionLine(route, runStart, corner, false);
        runStart = corner;
        continue;
      }

      const cut = Math.min(radius * tangentScale, incomingLength / 2, outgoingLength / 2);
      const actualRadius = cut / tangentScale;
      const arcStart = V3.subtract(new Vector3(), corner, V3.multiplyScalar(new Vector3(), incoming, cut));
      const arcEnd = V3.add(new Vector3(), corner, V3.multiplyScalar(new Vector3(), outgoing, cut));
      const leftNormal = new Vector3(-incoming.z, 0, incoming.x);
      const centre = V3.add(new Vector3(), arcStart,
        V3.multiplyScalar(new Vector3(), leftNormal, cross > 0 ? actualRadius : -actualRadius));

      this.appendMotionLine(route, runStart, arcStart, false);
      this.appendMotionArc(route, arcStart, arcEnd, centre, cross > 0 ? 1 : -1, false);
      runStart = arcEnd;
    }
    this.appendMotionLine(route, runStart, points[points.length - 1], false);
    return route;
  }

  private sampleSpacing(): number {
    return Math.max(0.01, this.u(this.routeSampleSpacing));
  }

  private appendMotionLine(route: MotionPoint[], from: Readonly<Vector3>, to: Readonly<Vector3>, reverse: boolean): void {
    const direction = V3.subtract(new Vector3(), to, from);
    direction.y = 0;
    const distance = direction.magnitude;
    if (distance <= 0.001) {
      return;
    }
    V3.multiplyScalar(direction, direction, 1 / distance);
    const steps = Math.max(1, Math.ceil(distance / this.sampleSpacing()));
    for (let index = 1; index <= steps; index++) {
      const position = V3.lerp(new Vector3(), from, to, index / steps);
      this.appendMotionPoint(route, position, this.yawForVisualForward(direction), reverse);
    }
  }

  private appendReverseLine(route: MotionPoint[], from: Readonly<Vector3>, to: Readonly<Vector3>, facing: Readonly<Vector3>): void {
    const distance = V3.distance(from, to);
    if (distance <= 0.001) {
      return;
    }
    const steps = Math.max(1, Math.ceil(distance / this.sampleSpacing()));
    const yaw = this.yawForVisualForward(facing);
    for (let index = 1; index <= steps; index++) {
      this.appendMotionPoint(route, V3.lerp(new Vector3(), from, to, index / steps), yaw, true);
    }
  }

  private appendMotionArc(
    route: MotionPoint[], from: Readonly<Vector3>, to: Readonly<Vector3>, centre: Readonly<Vector3>, turn: number, reverse: boolean,
  ): void {
    const startAngle = Math.atan2(from.z - centre.z, from.x - centre.x);
    let angle = Math.atan2(to.z - centre.z, to.x - centre.x) - startAngle;
    if (turn > 0 && angle < 0) angle += Math.PI * 2;
    if (turn < 0 && angle > 0) angle -= Math.PI * 2;
    const radius = V3.distance(from, centre);
    const steps = Math.max(1, Math.ceil(Math.abs(angle * radius) / this.sampleSpacing()));
    for (let index = 1; index <= steps; index++) {
      const current = startAngle + angle * index / steps;
      const position = new Vector3(centre.x + Math.cos(current) * radius, from.y, centre.z + Math.sin(current) * radius);
      const tangent = turn > 0 ? new Vector3(-Math.sin(current), 0, Math.cos(current))
        : new Vector3(Math.sin(current), 0, -Math.cos(current));
      this.appendMotionPoint(route, position, this.yawForVisualForward(tangent), reverse);
    }
  }

  private appendMotionPoint(route: MotionPoint[], position: Readonly<Vector3>, yaw: number, reverse: boolean): void {
    const previous = route[route.length - 1];
    if (previous !== undefined && V3.distance(previous.position, position) <= 0.001) {
      previous.yaw = yaw;
      previous.reverse = reverse;
      return;
    }
    route.push({ position: position.clone(), yaw, reverse });
  }

  /** Cocos node.forward is opposite to these imported vehicle visuals. */
  private yawForVisualForward(direction: Readonly<Vector3>): number {
    return Math.atan2(direction.x, direction.z) * 180 / Math.PI;
  }

  /** The vehicle's current nose direction (pose yaw without drift), flattened and normalized. */
  private forwardOf(vehicle: Vehicle): Vector3 {
    const radians = (vehicle.poseYaw - vehicle.driftYaw) * Math.PI / 180;
    return new Vector3(Math.sin(radians), 0, Math.cos(radians));
  }

  // ---------- Blocked feedback (ImpactBounceCommand + ImpactShoveCommand, single hop) ----------
  //
  // The tapped vehicle lunges toward whatever blocks it (accelerating, capped at
  // bounceLungeSpeed) and stops just short of contact; a gap tighter than
  // bounceMinNudge becomes body compression. At contact the nose punches down
  // (bounceImpactPitch/Squash) and the struck vehicle gets its shove; then a quick
  // rebound and a slower drift back along bounceBackCurve. No chain hops.
  private playBounceFeedback(vehicle: Vehicle, forward: Readonly<Vector3>): void {
    const scale = this.vehicleSpeedScale;
    const maxTravel = this.u(this.bounceMaxTravel);
    // ImpactBounceCommand: the rule's nearest blocker, and how far the body travels until it touches it.
    const self = this.footprintOf(vehicle);
    const blocker = this.exitBlockersOf(self, this.boardFootprints(vehicle))[0];
    const contact = blocker !== undefined ? this.timeOfImpact(self, forward, blocker.body, maxTravel) : Number.POSITIVE_INFINITY;
    const hit = blocker !== undefined && Number.isFinite(contact) ? { blocker: blocker.vehicle } : null;
    const halfLength = this.dimensionsOf(vehicle).length / 2;
    const contactFree = hit !== null ? contact - this.u(this.bounceContactGap) : maxTravel;
    let travel = contactFree;
    let peakCompression = 0;
    const minNudge = this.u(this.bounceMinNudge);
    if (hit !== null && travel < minNudge) {
      const need = minNudge - travel;
      peakCompression = Math.min(need / halfLength, this.bounceMaxCompression);
      travel = Math.max(0, travel + peakCompression * halfLength);
    }
    travel = Math.max(0, travel);

    const lungeSpeed = this.u(this.bounceLungeSpeed) * scale;
    const lungeAcceleration = this.u(this.bounceLungeAcceleration) * scale * scale;
    const lungeTime = this.bounceTimeToCover(travel, lungeSpeed, lungeAcceleration);

    const reboundDistance = Math.min(this.u(this.bounceReboundDistance), travel);
    const reboundTime = reboundDistance > 0 ? this.bounceReboundDuration / scale : 0;
    const back = travel - reboundDistance;
    const returnTime = back > 0
      ? Math.max(this.bounceReturnMinDuration / scale, back / (this.u(this.bounceReturnSpeed) * scale))
      : 0;
    const impactTime = hit !== null ? this.bounceImpactDuration / scale : 0;

    vehicle.isMoving = true;
    this.activeBounces.push({
      vehicle,
      origin: vehicle.posePosition.clone(),
      yaw: vehicle.poseYaw,
      direction: forward.clone(),
      halfLength,
      blocker: hit?.blocker ?? null,
      contactFree,
      peakCompression,
      travel,
      lungeSpeed,
      lungeAcceleration,
      lungeTime,
      reboundDistance,
      reboundTime,
      returnTime,
      impactTime,
      endTime: Math.max(lungeTime + reboundTime + returnTime, lungeTime + impactTime),
      contactPlayed: false,
      elapsed: 0,
    });
  }

  /** ImpactBounceCommand.OnTick; true when finished. */
  private stepBounce(bounce: VehicleBounce, deltaTime: number): boolean {
    bounce.elapsed += deltaTime;
    if (!bounce.contactPlayed && bounce.elapsed > bounce.lungeTime) {
      // The frame with the contact stops exactly at the contact pose.
      bounce.elapsed = bounce.lungeTime;
    }
    const t = Math.min(bounce.elapsed, bounce.endTime);
    let offset: number;
    let compression = 0;
    if (t < bounce.lungeTime) {
      offset = this.bounceCovered(t, bounce.lungeSpeed, bounce.lungeAcceleration);
      compression = Math.min(Math.max(0, offset - Math.max(0, bounce.contactFree)) / bounce.halfLength, bounce.peakCompression);
    } else {
      if (!bounce.contactPlayed) {
        bounce.contactPlayed = true;
        if (bounce.blocker !== null && this.vehicleObjectValid(bounce.blocker)) {
          this.beginShove(bounce.blocker, bounce.direction);
          // ImpactBounceCommand.ContactPoint: the nose at the contact pose (a tight gap
          // is absorbed by compression, so the nose stops at the contact). VFX listen to this.
          const front = Math.max(0, Math.min(bounce.travel, bounce.contactFree));
          const contact = V3.scaleAndAdd(new Vector3(), bounce.origin, bounce.direction, front + bounce.halfLength);
          EventBus.emit(GameEvents.VEHICLE_HIT, contact, bounce.vehicle, bounce.blocker);
        }
      }
      const after = t - bounce.lungeTime;
      if (after < bounce.reboundTime) {
        const k = MotionCurves.bounceBack.evaluate(after / bounce.reboundTime);
        offset = bounce.travel - bounce.reboundDistance * k;
        compression = bounce.peakCompression * (1 - k);
      } else {
        const back = after - bounce.reboundTime;
        const k = bounce.returnTime > 0 ? MotionCurves.bounceBack.evaluate(this.clamp(back / bounce.returnTime, 0, 1)) : 1;
        offset = (bounce.travel - bounce.reboundDistance) * (1 - k);
      }
    }
    const position = V3.scaleAndAdd(new Vector3(), bounce.origin, bounce.direction, offset);
    bounce.vehicle.setPose(position, bounce.yaw, 0, 0);

    let punch = 0;
    if (bounce.contactPlayed && bounce.impactTime > 0 && t - bounce.lungeTime < bounce.impactTime) {
      punch = MotionCurves.punchShape.evaluate((t - bounce.lungeTime) / bounce.impactTime);
    }
    const axis = V3.cross(new Vector3(), Vector3.up, bounce.direction);
    const tilt = quatFromAxisAngle(axis, punch * this.bounceImpactPitch * (Math.PI / 180));
    bounce.vehicle.setImpact(BOUNCE_LAYER, Vector3.zero, tilt, compression + punch * this.bounceImpactSquash);

    return bounce.elapsed >= bounce.endTime;
  }

  // ---------- Traffic bumps (not in Unity) ----------

  /**
   * Driving vehicles whose rule bodies start to overlap bump: the hit VFX at the
   * midpoint (GameEvents.VEHICLE_HIT) and the blocker shove on both, pushed apart.
   * A pair fires once per contact and re-arms after it separates.
   */
  private updateTrafficBumps(): void {
    if (!this.trafficBumpEnabled) {
      this.trafficContacts.clear();
      return;
    }
    const driving = this.activeDrives.map((drive) => drive.vehicle).filter((vehicle) => this.vehicleObjectValid(vehicle));
    const touching = new Set<string>();
    for (let i = 0; i < driving.length; i++) {
      const a = driving[i];
      const bodyA = this.footprintOf(a);
      for (let j = i + 1; j < driving.length; j++) {
        const b = driving[j];
        if (!this.footprintsOverlap(bodyA, this.footprintOf(b), 0, this.trafficBumpTolerance)) {
          continue;
        }
        const key = a.gameObject.id < b.gameObject.id ? `${a.gameObject.id}|${b.gameObject.id}` : `${b.gameObject.id}|${a.gameObject.id}`;
        touching.add(key);
        if (!this.trafficContacts.has(key)) {
          this.playTrafficBump(a, b);
        }
      }
    }
    this.trafficContacts = touching;
  }

  private playTrafficBump(a: Vehicle, b: Vehicle): void {
    const direction = V3.subtract(new Vector3(), b.posePosition, a.posePosition);
    direction.y = 0;
    if (direction.sqrMagnitude <= 1e-8) {
      direction.copy(this.forwardOf(a));
    }
    direction.normalize();
    const contact = V3.lerp(new Vector3(), a.posePosition, b.posePosition, 0.5);
    EventBus.emit(GameEvents.VEHICLE_HIT, contact, a, b);
    this.beginShove(b, direction);
    this.beginShove(a, V3.multiplyScalar(new Vector3(), direction, -1));
  }

  private beginShove(blocker: Vehicle, direction: Readonly<Vector3>): void {
    const scale = this.vehicleSpeedScale;
    const shoveTime = this.blockerShoveDuration / scale;
    const swayTime = this.blockerSwayDuration / scale;
    if (Math.max(shoveTime, swayTime) <= 0) {
      return;
    }

    const existing = this.activeShoves.find((s) => s.vehicle === blocker);
    if (existing !== undefined) {
      // Hit again while still reacting: restart the timer rather than stacking a second reaction.
      existing.direction = direction.clone();
      existing.shoveTime = shoveTime;
      existing.swayTime = swayTime;
      existing.elapsed = 0;
      return;
    }

    this.activeShoves.push({
      vehicle: blocker,
      direction: direction.clone(),
      shoveTime,
      swayTime,
      elapsed: 0,
    });
  }

  private applyShovePose(shove: VehicleShove): void {
    const t = shove.elapsed;
    const push = t < shove.shoveTime ? MotionCurves.punchShape.evaluate(this.clamp(t / shove.shoveTime, 0, 1)) : 0;
    let sway = 0;
    let twist = 0;
    if (t < shove.swayTime) {
      const left = 1 - t / shove.swayTime;
      const phase = 2 * Math.PI * this.blockerSwayFrequency * this.vehicleSpeedScale * t;
      sway = Math.sin(phase) * left * left * this.blockerSwayTilt;
      twist = Math.sin(phase + Math.PI / 2) * left * left * this.blockerSwayYaw;
    }

    const tiltAxis = V3.cross(new Vector3(), Vector3.up, shove.direction);
    const tiltAngle = (push * this.blockerShoveTilt + sway) * (Math.PI / 180);
    const tiltQuat = quatFromAxisAngle(tiltAxis, tiltAngle);
    const twistQuat = quatFromAxisAngle(Vector3.up, twist * (Math.PI / 180));
    const offset = V3.multiplyScalar(new Vector3(), shove.direction, push * this.u(this.blockerShoveDistance));
    shove.vehicle.setImpact(SHOVE_LAYER, offset, tiltQuat.multiply(twistQuat), 0);
  }

  /** Distance covered after `t` seconds accelerating from rest, capped at `lungeSpeed`. */
  private bounceCovered(t: number, lungeSpeed: number, lungeAcceleration: number): number {
    if (lungeAcceleration <= 0) {
      return lungeSpeed * t;
    }
    const rampTime = lungeSpeed / lungeAcceleration;
    if (t <= rampTime) {
      return (lungeAcceleration * t * t) / 2;
    }
    const rampDistance = (lungeSpeed * lungeSpeed) / (2 * lungeAcceleration);
    return rampDistance + lungeSpeed * (t - rampTime);
  }

  /** Inverse of `bounceCovered`: time to accelerate through `distance` from rest. */
  private bounceTimeToCover(distance: number, lungeSpeed: number, lungeAcceleration: number): number {
    const d = Math.max(0, distance);
    if (lungeAcceleration <= 0) {
      return lungeSpeed > 0 ? d / lungeSpeed : 0;
    }
    const rampDistance = (lungeSpeed * lungeSpeed) / (2 * lungeAcceleration);
    if (d <= rampDistance) {
      return Math.sqrt((2 * d) / lungeAcceleration);
    }
    const rampTime = lungeSpeed / lungeAcceleration;
    return rampTime + (d - rampDistance) / lungeSpeed;
  }

  private setBoardBounds(levelData: LevelData): void {
    let board: BoardRect;
    if (levelData.bounds_W.x > 0 && levelData.bounds_W.y > 0) {
      board = {
        minX: -levelData.bounds_W.x / 2,
        maxX: levelData.bounds_W.x / 2,
        minZ: -levelData.bounds_W.y / 2,
        maxZ: levelData.bounds_W.y / 2,
      };
    } else if (levelData.cars.length === 0) {
      board = { minX: -3, maxX: 3, minZ: -3, maxZ: 3 };
    } else {
      const xs = levelData.cars.map((car) => car.pos.x);
      const zs = levelData.cars.map((car) => -car.pos.y);
      board = {
        minX: Math.min(...xs) - 1,
        maxX: Math.max(...xs) + 1,
        minZ: Math.min(...zs) - 1,
        maxZ: Math.max(...zs) + 1,
      };
    }
    // Vehicle world positions sit under the scaled spawnRoot (vehicleScale), so the
    // board rect they're compared against (exit distance, live board bounds) must
    // shrink by the same factor.
    this.board = {
      minX: board.minX * this.vehicleScale,
      maxX: board.maxX * this.vehicleScale,
      minZ: board.minZ * this.vehicleScale,
      maxZ: board.maxZ * this.vehicleScale,
    };
  }

  private distanceToBoardEdge(position: Readonly<Vector3>, direction: Readonly<Vector3>, board: BoardRect = this.board): number {
    let xDistance = Number.POSITIVE_INFINITY;
    let zDistance = Number.POSITIVE_INFINITY;
    if (direction.x > 0.0001) xDistance = (board.maxX - position.x) / direction.x;
    else if (direction.x < -0.0001) xDistance = (board.minX - position.x) / direction.x;
    if (direction.z > 0.0001) zDistance = (board.maxZ - position.z) / direction.z;
    else if (direction.z < -0.0001) zDistance = (board.minZ - position.z) / direction.z;
    return Math.max(0, Math.min(xDistance, zDistance));
  }

  private snapToEdge(rect: BoardRect, point: Readonly<Vector3>): Vector3 {
    const x = this.clamp(point.x, rect.minX, rect.maxX);
    const z = this.clamp(point.z, rect.minZ, rect.maxZ);
    const distances = [x - rect.minX, rect.maxX - x, z - rect.minZ, rect.maxZ - z];
    const nearest = Math.min(...distances);
    if (nearest === distances[0]) return new Vector3(rect.minX, point.y, z);
    if (nearest === distances[1]) return new Vector3(rect.maxX, point.y, z);
    if (nearest === distances[2]) return new Vector3(x, point.y, rect.minZ);
    return new Vector3(x, point.y, rect.maxZ);
  }

  private addShortestPerimeterPath(route: Vector3[], rect: BoardRect, from: Readonly<Vector3>, to: Readonly<Vector3>, height: number): void {
    const width = rect.maxX - rect.minX;
    const depth = rect.maxZ - rect.minZ;
    const perimeter = 2 * (width + depth);
    const start = this.perimeterOffset(rect, from);
    const end = this.perimeterOffset(rect, to);
    const forwardDistance = this.wrap(end - start, perimeter);
    const forward = forwardDistance <= perimeter - forwardDistance;
    const span = forward ? forwardDistance : perimeter - forwardDistance;
    const corners = [0, width, width + depth, 2 * width + depth]
      .map((cornerOffset) => ({
        cornerOffset,
        distance: forward
          ? this.wrap(cornerOffset - start, perimeter)
          : this.wrap(start - cornerOffset, perimeter),
      }))
      .filter((corner) => corner.distance > 0.001 && corner.distance < span - 0.001)
      .sort((a, b) => a.distance - b.distance);
    for (const corner of corners) {
      route.push(this.cornerAt(rect, corner.cornerOffset, height));
    }
    route.push(new Vector3(to.x, height, to.z));
  }

  private perimeterOffset(rect: BoardRect, point: Readonly<Vector3>): number {
    const x = this.clamp(point.x, rect.minX, rect.maxX);
    const z = this.clamp(point.z, rect.minZ, rect.maxZ);
    const left = Math.abs(x - rect.minX);
    const right = Math.abs(rect.maxX - x);
    const bottom = Math.abs(z - rect.minZ);
    const top = Math.abs(rect.maxZ - z);
    const nearest = Math.min(left, right, bottom, top);
    const width = rect.maxX - rect.minX;
    const depth = rect.maxZ - rect.minZ;
    if (nearest === bottom) return x - rect.minX;
    if (nearest === right) return width + z - rect.minZ;
    if (nearest === top) return width + depth + rect.maxX - x;
    return 2 * width + depth + rect.maxZ - z;
  }

  private cornerAt(rect: BoardRect, offset: number, height: number): Vector3 {
    const width = rect.maxX - rect.minX;
    const depth = rect.maxZ - rect.minZ;
    if (offset === 0) return new Vector3(rect.minX, height, rect.minZ);
    if (offset === width) return new Vector3(rect.maxX, height, rect.minZ);
    if (offset === width + depth) return new Vector3(rect.maxX, height, rect.maxZ);
    return new Vector3(rect.minX, height, rect.maxZ);
  }

  private removeDuplicatePoints(points: Vector3[], start: Readonly<Vector3>): Vector3[] {
    const result: Vector3[] = [];
    let previous = start;
    for (const point of points) {
      if (V3.distance(previous, point) > 0.001) {
        result.push(point);
        previous = point;
      }
    }
    return result;
  }

  private playBlockedFeedback(vehicle: Vehicle): void {
    // No free slot: Unity shows a warning cue only; a small pop stands in for it.
    this.playVehiclePop(vehicle, 0.06, 0.2 / Math.max(0.0001, this.vehicleSpeedScale), undefined);
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  private lerp(from: number, to: number, t: number): number {
    return from + (to - from) * t;
  }

  private wrap(value: number, period: number): number {
    const remainder = value % period;
    return remainder < 0 ? remainder + period : remainder;
  }

  private resolveKind(data: VehicleData): VehicleKind | null {
    const explicitKind = (data.kind ?? '').trim().toLowerCase();
    switch (explicitKind) {
      case VehicleKind.Car: return VehicleKind.Car;
      case VehicleKind.Van: return VehicleKind.Van;
      case VehicleKind.Bus: return VehicleKind.Bus;
    }

    switch (data.seats) {
      case 16: return VehicleKind.Car;
      case 24: return VehicleKind.Van;
      case 40: return VehicleKind.Bus;
      default: return null;
    }
  }

  private prefabFor(kind: VehicleKind): GameObject | null {
    switch (kind) {
      case VehicleKind.Car: return ServiceLocator.get(GameConfiSO).carPrefab;
      case VehicleKind.Van: return ServiceLocator.get(GameConfiSO).vanPrefab;
      case VehicleKind.Bus: return ServiceLocator.get(GameConfiSO).busPrefab;
    }
  }

  private clearSpawnedVehicles(): void {
    this.activePops.clear();
    this.waits.length = 0;
    this.activeDrives.length = 0;
    this.activeBounces.length = 0;
    this.activeShoves.length = 0;
    this.trafficContacts.clear();
    for (const go of this.spawnedObjects) {
      if (isAlive(go)) {
        this.destroy(go);
      }
    }
    this.spawnedObjects.length = 0;
  }
}
