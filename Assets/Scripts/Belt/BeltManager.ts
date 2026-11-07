import { Color, Debug, field, foldoutGroup, GameObject, Gizmos, isAlive, MonoBehaviour, Quaternion, Time, Vector3 } from '@pia/core';
import { SplineContainer } from 'com.pia.spline';
import { EventBus } from '../EventBus';
import { quatFromViewUp, quatSlerp, V3 } from '../Utils/CocosMath';
import { pathDirection, pathLength, pathRotation } from '../Utils/CocosSpline';
import { ExitGate } from './ExitGate';
import { LevelData } from '../Data/LevelData';
import { MotionCurves } from '../Data/MotionCurves';
import { GameEvents } from '../GameEvents';
import { Pacing } from '../Pacing';
import { ParkingManager } from '../Parking/ParkingManager';
import { Slot } from '../Parking/Slot';
import { PassengerManager, PassengerQueueSide } from '../Passenger/PassengerManager';
import { Vehicle } from '../Vehicle/Vehicle';
import { VehicleManager } from '../Vehicle/VehicleManager';
// TODO(AudioManager): the Cocos version plays AudioManager.instance.playOneShot('Pop') when a
// figure lands; kept as a comment (see land()) until AudioManager is ported.

/** Cocos Color.GREEN / CYAN / MAGENTA (PiaEngine colours are 0..1). */
const GIZMO_GREEN = new Color(0, 1, 0, 1);
const GIZMO_CYAN = new Color(0, 1, 1, 1);
const GIZMO_MAGENTA = new Color(1, 0, 1, 1);

/** PassengerLeaveQueueCommand: walk in the frame of the moving row, Hermite from the queue head to the row. */
interface RowJoin {
    fromOffset: Vector3;
    fromVelocity: Vector3;
    fromRotation: Quaternion;
    duration: number;
    elapsed: number;
}

/** One belt row (BeltCrowd slot). A token is one seat: four same-color figures side by side. */
interface BeltRow {
    color: number;
    figures: GameObject[];
    /** Walking from the queue head; null once seated on the belt. */
    join: RowJoin | null;
    /** Its figures are streaming to a vehicle. */
    leaving: boolean;
    /** Figures that already left the row as runners. */
    gone: boolean[];
}

/** BeltDemandModel bookkeeping for one parked vehicle (ParkedVehicle.SeatsLeft + presentation counters). */
interface BoardingVehicle {
    vehicle: Vehicle;
    slot: Slot;
    color: number;
    capacity: number;
    /** Seats not yet assigned to a belt row. */
    seatsLeft: number;
    /** Figures assigned to this vehicle that have not landed yet. */
    runnersInFlight: number;
    /** PresentationContext.NextStreamSerial: alternates the stream lanes. */
    streamSerial: number;
    /** Figures that reached the vehicle (VehicleView.BoardedFigures), for the slot count label. */
    boardedFigures: number;
}

/** PassengerStreamAboardCommand.Runner. */
interface Runner {
    row: BeltRow;
    rowIndex: number;
    figure: number;
    target: BoardingVehicle;
    path: Vector3[];
    along: number[];
    runLength: number;
    runDuration: number;
    speed: number;
    bodyEdge: number;
    /** Passenger-clock seconds since the row started boarding, and this figure's turn. */
    start: number;
    elapsed: number;
    left: boolean;
    baseScale: Vector3;
}

/**
 * Belt, feeding and boarding, ported from Unity's standard rule set and its
 * stream presentation:
 *
 * - BeltCrowd / PassengerLeaveQueueCommand: a queue head leaves when an empty
 *   row is within beltJoinReachRows of its aim point, claims it, and walks onto
 *   it (Hermite in the row's moving frame) so it arrives at belt speed.
 * - FillFirstBoardingRule: a seated row at the exit gate boards the parked
 *   vehicle of its color which already started, then the one with the fewest
 *   seats left, then the left-most slot.
 * - PassengerStreamAboardCommand: figures leave the row streamExitInterval
 *   apart, run belt mouth -> walkway -> the vehicle end facing the belt -> into
 *   the body, shrinking along streamEntryScaleCurve; each landing kicks the
 *   board pop. A full vehicle departs (VehicleDepartedPresenter).
 * - Win when every passenger boarded; lose when every slot is clogged and no
 *   waiting passenger can board (ParkingFullLoseRule).
 *
 * Distances and speeds are Unity world values, multiplied by the belt ratio
 * (this BeltPath length / Unity's loop length) so timings match the original.
 */
// Inspector groups (collapsible sections).
const GROUP_BELT = 'Belt';
const GROUP_SCALE = 'Unit Scale';
const GROUP_GATE = 'Exit Gate & Joins';
const GROUP_FEED = 'Feed';
const GROUP_STREAM = 'Boarding Stream';
const GROUP_LAYOUT = 'Boarding Layout';

export class BeltManager extends MonoBehaviour {
    // ---------- Belt ----------

    @foldoutGroup(GROUP_BELT) @field(SplineContainer)
    beltPath: SplineContainer | null = null;

    /** MotionTuning.beltSpeed (Unity units / second). */
    @foldoutGroup(GROUP_BELT) @field({ label: 'Tốc độ khách chạy trên đường' })
    speed: number = 0.8;

    /**
     * Belt speed once every vehicle has left the board (end of the level), same units
     * as `speed`. The belt eases into it over Pacing.beltFactorResponseSeconds. 0 = keep `speed`.
     */
    @foldoutGroup(GROUP_BELT) @field({ label: 'Tốc độ khách chạy trên đường cuối game' })
    endSpeed: number = 0;

    /** Override for the loop capacity. 0 uses `loop_model` (busgo-unity-2.import.json loopModels). */
    @foldoutGroup(GROUP_BELT) @field({ type: 'int', label: 'Số hàng ngang khách chạy trên đường' }) // số hàng ngang trên đường main spline
    capacityOverride: number = 0;

    /** Distance between the four figures of a row across the belt. 0 = Unity's cell (0.1039) scaled. */
    @foldoutGroup(GROUP_BELT) @field({ label: 'khoảng cách chiều ngang giữa mấy thằng khách' })
    figureSpacingOverride: number = 0;

    // ---------- Unit Scale ----------

    /** Length of Unity's belt loop (MapLoopShape, world units). */
    @foldoutGroup(GROUP_SCALE)
    unityBeltLength: number = 10.2282;

    /** Scene units per Unity unit for the crowd. 0 = BeltPath length / unityBeltLength. */
    @foldoutGroup(GROUP_SCALE)
    crowdScaleOverride: number = 0;

    // ---------- Exit Gate & Joins ----------
    // The t values are measured on this scene's BeltPath (clockwise on screen,
    // t = 0 at the bottom-left corner). Tune them with the gizmos.

    /**
     * Exit gate box placed in the scene. When set, a row may board while its centre
     * is inside the box (or crossed it this frame), and the node position is the
     * pickup point; exitGateCenter / exitGateLength are then unused.
     */
    @foldoutGroup(GROUP_GATE) @field(ExitGate)
    exitGate: ExitGate | null = null;

    /** Centre of the exit gate (the shape's pickup point), facing the parking row. Without exitGate only. */
    @foldoutGroup(GROUP_GATE)
    exitGateCenter: number = 0.898;

    /** MapLoopShape.exitGateLength, as a fraction of the loop. */
    @foldoutGroup(GROUP_GATE)
    exitGateLength: number = 0.078;

    /**
     * Spline t where the left queue meets the loop. Used only when the queue has
     * no path; with PassengerManager.leftQueuePath the join is the point of the
     * loop nearest to the path's last knot (SceneLayout.queueJoinT).
     */
    @foldoutGroup(GROUP_GATE)
    leftJoinT: number = 0.045;

    /** Spline t where the right queue meets the loop (see leftJoinT). */
    @foldoutGroup(GROUP_GATE)
    rightJoinT: number = 0.75;

    // ---------- Feed (queue -> belt), MotionTuning ----------

    @foldoutGroup(GROUP_FEED) feedInterval: number = 0.05;
    @foldoutGroup(GROUP_FEED) queueWalkSpeed: number = 1.6;
    @foldoutGroup(GROUP_FEED) beltJoinMinDuration: number = 0.12;
    @foldoutGroup(GROUP_FEED) beltJoinReachRows: number = 0.6;
    /**
     * Rule joins (team/standard ruleset demand.joinsByShape.loop_default): where each
     * queue joins the loop, as a fraction of the loop after the exit. They decide how
     * many passengers each queue puts on the belt (BeltDemandModel), whatever the
     * scene geometry: the opening split, then who refills each freed row.
     */
    @foldoutGroup(GROUP_FEED) ruleLeftJoin: number = 0.296;
    @foldoutGroup(GROUP_FEED) ruleRightJoin: number = 0.7;

    // ---------- Boarding Stream (belt -> vehicle), MotionTuning + SceneLayout ----------

    @foldoutGroup(GROUP_STREAM) streamRunSpeed: number = 3;
    @foldoutGroup(GROUP_STREAM) streamExitInterval: number = 0.05;
    @foldoutGroup(GROUP_STREAM) streamEntryShrinkDistance: number = 0.15;
    @foldoutGroup(GROUP_STREAM) streamLaneCount: number = 2;
    @foldoutGroup(GROUP_STREAM) streamLaneSpacing: number = 0.03;
    @foldoutGroup(GROUP_STREAM) streamMouthHalfWidth: number = 0.65;
    /** MotionTuning.countFadeInDuration: the slot count label fades in this long when a vehicle parks. */
    @foldoutGroup(GROUP_STREAM) countFadeInDuration: number = 0.25;

    // ---------- Boarding Layout (StandardSceneLayout, Unity units; +Z there points from the parking row to the belt) ----------

    @foldoutGroup(GROUP_LAYOUT) boardingMouthOffsetX: number = 0.12;
    @foldoutGroup(GROUP_LAYOUT) boardingMouthOffsetZ: number = -0.25;
    @foldoutGroup(GROUP_LAYOUT) boardingLaneOffsetZ: number = 0.4;
    @foldoutGroup(GROUP_LAYOUT) boardingPointClearance: number = 0.045;

    private static readonly LOOP_CAPACITY: Record<string, number> = {
        main_loop_1: 27,
        main_loop_2: 31,
        main_loop_3: 32,
    };
    private static readonly UNITY_FIGURE_CELL = 0.1039;

    /** Lose reasons sent with GameEvents.LOSE_GAME (ruleset endReasons). */
    public static readonly LOSE_PARKING_FULL = 'parking_full';
    public static readonly LOSE_NO_EXIT = 'no_exit';

    private passengerManager: PassengerManager | null = null;
    private vehicleManager: VehicleManager | null = null;
    private parkingManager: ParkingManager | null = null;
    private rows: (BeltRow | null)[] = [];
    /** Belt offset as a fraction of the loop; row i sits at (phase + (i + 0.5) / rows.length) mod 1. */
    private _phase = 0;
    private _previousPhase = 0;
    private _length = 0;
    private _unit = 1;
    private feedCooldown: Record<PassengerQueueSide, number> = { Left: 0, Right: 0 };
    /** Passengers the rules have assigned to each queue but that have not left it yet. */
    private feedQuota: Record<PassengerQueueSide, number> = { Left: 0, Right: 0 };
    private joinTCache: Partial<Record<PassengerQueueSide, number>> = {};
    private boarding: BoardingVehicle[] = [];
    private runners: Runner[] = [];
    private _departing = 0;
    private _ended = false;
    /** 0 -> 1 while easing from `speed` to `endSpeed` after the board is cleared. */
    private _endBlend = 0;
    private _running = false;

    onEnable(): void {
        EventBus.on(GameEvents.VEHICLE_PARKED, this.onVehicleParked);
    }

    onDisable(): void {
        EventBus.off(GameEvents.VEHICLE_PARKED, this.onVehicleParked);
    }

    initialize(
        levelData: LevelData,
        passengerManager: PassengerManager | null,
        vehicleManager: VehicleManager | null,
        parkingManager: ParkingManager | null,
    ): void {
        this._running = false;
        this.clearAll();
        if (passengerManager === null || vehicleManager === null || parkingManager === null) {
            Debug.error('[BeltManager] LevelManager must assign passengerManager, vehicleManager and parkingManager.');
            return;
        }
        if (this.beltPath === null) {
            Debug.error('[BeltManager] Assign BeltPath (SplineContainer) in the Inspector.');
            return;
        }
        this._length = pathLength(this.beltPath!);
        if (this._length <= 0) {
            Debug.error('[BeltManager] BeltPath has no usable length. Draw at least two knots.');
            return;
        }

        this.passengerManager = passengerManager;
        this.joinTCache = {};
        this.joinTCache = { Left: this.joinT('Left'), Right: this.joinT('Right') };
        this.vehicleManager = vehicleManager;
        this.parkingManager = parkingManager;
        this._unit = this.crowdScaleOverride > 0 ? this.crowdScaleOverride : this._length / this.unityBeltLength;

        const capacity = this.resolveCapacity(levelData);
        this.rows = new Array<BeltRow | null>(capacity).fill(null);
        this._phase = 0;
        this._previousPhase = 0;
        this.feedCooldown = { Left: 0, Right: 0 };
        this.feedQuota = this.openingQuota(capacity);
        this._ended = false;
        this._endBlend = 0;
        this._running = true;
    }

    update(): void {
        const deltaTime = Time.deltaTime;
        if (!this._running || this.rows.length === 0) {
            return;
        }
        Pacing.advance(deltaTime);
        const crowdTime = deltaTime * Pacing.crowd;
        const feedTime = deltaTime * Pacing.feed;

        // The belt follows real time and its own factor: it is the eye's speed reference.
        if (Pacing.boardCleared && this._endBlend < 1) {
            // Ease into endSpeed so the whole loop does not jump.
            const response = Pacing.beltFactorResponseSeconds;
            this._endBlend = response > 0 ? Math.min(1, this._endBlend + deltaTime / response) : 1;
        }
        this._previousPhase = this._phase;
        this._phase = this.wrap01(this._phase + (deltaTime * this.beltSpeed() * Pacing.belt) / this._length);

        this.feed(feedTime);

        for (let index = 0; index < this.rows.length; index++) {
            const row = this.rows[index];
            if (row === null) {
                continue;
            }
            if (row.join !== null) {
                row.join.elapsed += crowdTime;
                if (row.join.elapsed >= row.join.duration) {
                    row.join = null;
                }
            }
            this.placeRow(index, row);
            if (row.join === null && !row.leaving && this.isAtExitGate(index)) {
                this.tryBoardRow(index, row);
            }
        }

        this.updateRunners(crowdTime);
        Pacing.feeding = this.isFeeding();
        this.checkEnd();
    }

    // ---------- Feeding (PassengerLeaveQueueCommand, BeltCrowd.Claim) ----------

    private feed(feedTime: number): void {
        for (const side of ['Left', 'Right'] as PassengerQueueSide[]) {
            this.feedCooldown[side] = Math.max(0, this.feedCooldown[side] - feedTime);
            // Only passengers the rules sent to the belt leave the queue.
            if (this.feedCooldown[side] > 0 || this.feedQuota[side] <= 0 || !this.passengerManager!.hasWaitingGroup(side)) {
                continue;
            }
            const aim = this.queueJoinAimT(side);
            const index = this.nearestFreeRow(aim, this.beltJoinReachRows / this.rows.length);
            if (index < 0) {
                continue;
            }
            this.claimRow(index, side);
            this.feedQuota[side]--;
            this.feedCooldown[side] = this.feedInterval;
        }
    }

    /** Rule join of a queue, as a fraction of the loop after the exit. */
    private ruleJoin(side: PassengerQueueSide): number {
        return this.wrap01(side === 'Left' ? this.ruleLeftJoin : this.ruleRightJoin);
    }

    /** Passengers still waiting in a queue that the rules have not assigned yet. */
    private unassigned(side: PassengerQueueSide, assigned: Record<PassengerQueueSide, number>): number {
        return this.passengerManager!.remainingGroupCount(side) - assigned[side];
    }

    /**
     * BeltDemandModel.FillOpening: the empty belt's row s at (s + 0.5) / C (from the
     * exit) is filled by the queue whose join it meets first going round; if that
     * queue has nobody left, by the next join downstream. Rows are taken in order of
     * their distance to that join (ties: lower row first). Returns the split.
     */
    private openingQuota(capacity: number): Record<PassengerQueueSide, number> {
        const quota: Record<PassengerQueueSide, number> = { Left: 0, Right: 0 };
        const sides: PassengerQueueSide[] = ['Left', 'Right'];
        const slots: { index: number; distance: number; side: PassengerQueueSide }[] = [];
        for (let s = 0; s < capacity; s++) {
            const position = (s + 0.5) / capacity;
            let nearest: PassengerQueueSide = sides[0];
            let nearestDistance = this.aheadOf(position, this.ruleJoin(nearest));
            for (const side of sides.slice(1)) {
                const distance = this.aheadOf(position, this.ruleJoin(side));
                if (distance < nearestDistance) {
                    nearest = side;
                    nearestDistance = distance;
                }
            }
            slots.push({ index: s, distance: nearestDistance, side: nearest });
        }
        slots.sort((a, b) => a.distance !== b.distance ? a.distance - b.distance : a.index - b.index);
        for (const slot of slots) {
            const side = this.downstreamWithPassengers(slot.side, quota);
            if (side === null) {
                break;
            }
            quota[side]++;
        }
        return quota;
    }

    /** BeltDemandModel.DownstreamWithPassengers: `start`, else the next join round the loop with someone unassigned. */
    private downstreamWithPassengers(start: PassengerQueueSide, assigned: Record<PassengerQueueSide, number>): PassengerQueueSide | null {
        let best: PassengerQueueSide | null = null;
        let bestDistance = 0;
        for (const side of ['Left', 'Right'] as PassengerQueueSide[]) {
            if (this.unassigned(side, assigned) <= 0) {
                continue;
            }
            const distance = this.aheadOf(this.ruleJoin(start), this.ruleJoin(side));
            if (best === null || distance < bestDistance) {
                best = side;
                bestDistance = distance;
            }
        }
        return best;
    }

    /**
     * BeltDemandModel.Refill after the opening: a row frees at the exit, so the queue
     * whose join comes first after the exit (smallest rule join) refills it; the next
     * one only once that queue has nobody left.
     */
    private assignRefill(): void {
        const order = (['Left', 'Right'] as PassengerQueueSide[])
            .sort((a, b) => this.ruleJoin(a) !== this.ruleJoin(b) ? this.ruleJoin(a) - this.ruleJoin(b) : (a === 'Left' ? -1 : 1));
        for (const side of order) {
            if (this.unassigned(side, this.feedQuota) > 0) {
                this.feedQuota[side]++;
                return;
            }
        }
    }

    /**
     * PresentationContext.QueueJoinAimT: where the row must be when the head leaves,
     * so that walking the head distance it meets the row exactly as it reaches belt speed.
     */
    private queueJoinAimT(side: PassengerQueueSide): number {
        const joinT = this.joinT(side);
        // Layout.QueueHeadDistance: along the branch path; without one, straight from the head figures.
        let headDistance = this.passengerManager!.queueHeadDistance(side);
        if (headDistance === null) {
            const head = this.groupCenter(this.passengerManager!.headFigures(side));
            headDistance = head !== null ? V3.distance(head, this.queueJoinPoint(side)) : 0;
        }
        const walk = Math.max(this.beltJoinMinDuration, headDistance / this.u(this.queueWalkSpeed));
        return this.wrap01(joinT - this.beltSpeedPerPassengerSecond() * walk / 2 / this._length);
    }

    /** BeltCrowd.NearestFree: closest empty row within reach; a row that swept past `t` this frame counts as on it. */
    private nearestFreeRow(t: number, reach: number): number {
        let best = -1;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (let index = 0; index < this.rows.length; index++) {
            if (this.rows[index] !== null) {
                continue;
            }
            let distance = Math.abs(this.rowT(index) - t);
            distance = Math.min(distance, 1 - distance);
            if (this.sweptPast(index, t)) {
                distance = 0;
            }
            if (distance <= reach && distance < bestDistance) {
                best = index;
                bestDistance = distance;
            }
        }
        return best;
    }

    private claimRow(index: number, side: PassengerQueueSide): void {
        const color = this.passengerManager!.peekNextColor(side);
        const head = this.passengerManager!.headFigures(side);
        const center = this.groupCenter(head);
        const fromRotation = head[0]?.transform.rotation.clone() ?? new Quaternion();
        const figures = this.passengerManager!.takeNextPassengerGroup(side, this.gameObject);
        if (figures.length === 0 || color === null || center === null) {
            return;
        }

        const t = this.rowT(index);
        const rowPosition = this.beltPath!.evaluatePosition(t);
        const forward = pathDirection(this.beltPath!, t);
        const beltSpeed = this.beltSpeedPerPassengerSecond();
        const fromOffset = V3.subtract(new Vector3(), center, rowPosition);
        // Standing still when leaving the head: relative to the moving row it moves backwards at belt speed.
        const fromVelocity = V3.multiplyScalar(new Vector3(), forward, -beltSpeed);
        let walk = V3.distance(center, this.queueJoinPoint(side)) / this.u(this.queueWalkSpeed);
        // Along the belt the walker only speeds up (never waits for the row) when T >= 1.5x,
        // and never overtakes belt speed when T <= 3x, x being the row's lead in seconds.
        const arrive = beltSpeed > 0 ? V3.dot(fromOffset, forward) / beltSpeed : 0;
        if (arrive > 0) {
            walk = Math.min(Math.max(walk, 1.5 * arrive), 3 * arrive);
        }
        this.rows[index] = {
            color,
            figures,
            join: {
                fromOffset,
                fromVelocity,
                fromRotation,
                duration: Math.max(this.beltJoinMinDuration, walk),
                elapsed: 0,
            },
            leaving: false,
            gone: figures.map(() => false),
        };
    }

    /** Unity's Feed/Queue tracks are active: someone still has to leave a queue, walk onto the belt, or the line steps up. */
    private isFeeding(): boolean {
        return this.passengerManager!.isStepping
            || this.feedQuota.Left > 0 || this.feedQuota.Right > 0
            || this.rows.some((row) => row !== null && row.join !== null);
    }

    // ---------- FillFirstBoardingRule ----------

    private onVehicleParked = (vehicle: Vehicle, slot: Slot): void => {
        if (!this._running || this.boarding.some((entry) => entry.vehicle === vehicle)) {
            return;
        }
        const capacity = vehicle.capacity;
        const entry: BoardingVehicle = {
            vehicle,
            slot,
            color: vehicle.data!.color,
            capacity,
            seatsLeft: capacity,
            runnersInFlight: 0,
            streamSerial: 0,
            boardedFigures: 0,
        };
        this.boarding.push(entry);
        // VehiclePlacementCommand(Parked): the slot shows how many figures are still missing.
        slot.showCount(this.remainingFigures(entry), this.countFadeInDuration);
    };

    /** VehicleView.RemainingFigures: GD figures (seats) minus figures that reached the vehicle. */
    private remainingFigures(entry: BoardingVehicle): number {
        return Math.max(0, (entry.vehicle.data?.seats ?? 0) - entry.boardedFigures);
    }

    /** Started vehicles first, then fewest seats left, then the left-most slot. */
    private chooseVehicle(color: number): BoardingVehicle | null {
        let best: BoardingVehicle | null = null;
        for (const entry of this.boarding) {
            if (entry.color !== color || entry.seatsLeft <= 0 || !isAlive(entry.vehicle.gameObject)
                || entry.vehicle.isMoving || !entry.vehicle.isParked) {
                continue;
            }
            if (best === null || this.compareBoarding(entry, best) < 0) {
                best = entry;
            }
        }
        return best;
    }

    private compareBoarding(a: BoardingVehicle, b: BoardingVehicle): number {
        const aStarted = a.seatsLeft < a.capacity;
        const bStarted = b.seatsLeft < b.capacity;
        if (aStarted !== bStarted) {
            return aStarted ? -1 : 1;
        }
        if (a.seatsLeft !== b.seatsLeft) {
            return a.seatsLeft - b.seatsLeft;
        }
        return a.slot.index - b.slot.index;
    }

    // ---------- PassengerStreamAboardCommand ----------

    /** streamLeaveWholeGate: a row at the gate leaves at once, figure k after k * streamExitInterval. */
    private tryBoardRow(index: number, row: BeltRow): void {
        const target = this.chooseVehicle(row.color);
        if (target === null) {
            return;
        }
        target.seatsLeft--;
        row.leaving = true;
        // RuleEngine.Settle: the passenger left the belt bag, so the demand model refills one place.
        this.assignRefill();

        const length = this.vehicleManager!.dimensionsOf(target.vehicle).length;
        const boardingPoint = this.boardingPoint(target.vehicle, length);
        const exitPoint = this.streamExitPoint(boardingPoint);
        const order = row.figures.map((_, figure) => figure);
        order.sort((a, b) => {
            const da = V3.squaredDistance(row.figures[a].transform.position, exitPoint);
            const db = V3.squaredDistance(row.figures[b].transform.position, exitPoint);
            return da !== db ? da - db : a - b;
        });
        order.forEach((figure, k) => {
            const path = [row.figures[figure].transform.position.clone()];
            this.appendBoardingStream(boardingPoint, this.streamLaneOffset(target.streamSerial++), path);
            path.push(target.vehicle.posePosition.clone());
            const runner: Runner = {
                row,
                rowIndex: index,
                figure,
                target,
                path,
                along: [],
                runLength: 0,
                runDuration: 0,
                speed: 0,
                bodyEdge: 0,
                start: k * this.streamExitInterval,
                elapsed: 0,
                left: false,
                baseScale: row.figures[figure].transform.localScale,
            };
            this.measure(runner);
            runner.bodyEdge = Math.max(0, runner.runLength - length / 2);
            runner.runDuration = runner.runLength / this.u(this.streamRunSpeed);
            runner.speed = this.u(this.streamRunSpeed);
            this.runners.push(runner);
            target.runnersInFlight++;
        });
    }

    private updateRunners(crowdTime: number): void {
        const shrinkDistance = this.u(this.streamEntryShrinkDistance);
        for (let i = this.runners.length - 1; i >= 0; i--) {
            const runner = this.runners[i];
            runner.elapsed += crowdTime;
            if (runner.elapsed < runner.start) {
                continue;
            }
            if (!runner.left) {
                this.leaveRow(runner);
            }
            const node = runner.row.figures[runner.figure];
            if (!isAlive(node)) {
                this.runners.splice(i, 1);
                runner.target.runnersInFlight--;
                continue;
            }
            const distance = Math.min(runner.runLength, runner.speed * (runner.elapsed - runner.start));
            this.run(runner, node, distance, shrinkDistance);
            if (distance >= runner.runLength) {
                this.runners.splice(i, 1);
                this.destroy(node);
                this.land(runner);
            }
        }
    }

    /**
     * The figure leaves from where the row is now; the run keeps its planned
     * duration (the start only moved by the belt drift while waiting its turn).
     */
    private leaveRow(runner: Runner): void {
        runner.left = true;
        const node = runner.row.figures[runner.figure];
        runner.path[0] = node.transform.position.clone();
        const duration = runner.runDuration;
        const lengthBefore = runner.runLength;
        this.measure(runner);
        runner.bodyEdge = Math.max(0, runner.bodyEdge + (runner.runLength - lengthBefore));
        runner.speed = duration > 0 ? runner.runLength / duration : this.u(this.streamRunSpeed);
        runner.baseScale = node.transform.localScale;
        runner.row.gone[runner.figure] = true;
        if (runner.row.gone.every((gone) => gone) && this.rows[runner.rowIndex] === runner.row) {
            // The last figure left: the row is free for the queues again.
            this.rows[runner.rowIndex] = null;
        }
    }

    /** PassengerStreamAboardCommand.Run: shrink along streamEntryScaleCurve over the last shrinkDistance before the body. */
    private run(runner: Runner, node: GameObject, distance: number, shrinkDistance: number): void {
        let segment = 1;
        while (segment < runner.path.length - 1 && runner.along[segment] < distance) {
            segment++;
        }
        const a = runner.path[segment - 1];
        const b = runner.path[segment];
        const span = runner.along[segment] - runner.along[segment - 1];
        const k = span > 0 ? this.clamp01((distance - runner.along[segment - 1]) / span) : 1;
        node.transform.position = V3.lerp(new Vector3(), a, b, k);
        const heading = V3.subtract(new Vector3(), b, a);
        heading.y = 0;
        if (heading.magnitude > 0.0001) {
            node.transform.rotation = quatFromViewUp(V3.normalize(heading, heading), Vector3.up);
        }
        const shrink = shrinkDistance > 0
            ? this.clamp01(1 - (runner.bodyEdge - distance) / shrinkDistance)
            : (distance >= runner.bodyEdge ? 1 : 0);
        node.transform.localScale = V3.multiplyScalar(new Vector3(), runner.baseScale, MotionCurves.streamEntryScale.evaluate(shrink));
    }

    private land(runner: Runner): void {
        const target = runner.target;
        target.runnersInFlight--;
        if (!isAlive(target.vehicle.gameObject)) {
            return;
        }
        target.vehicle.kickBoardPop();
        target.boardedFigures++;
        target.slot.showCount(this.remainingFigures(target), this.countFadeInDuration);
        // Debug.log("Ăn");
        // TODO(AudioManager): AudioManager.instance.playOneShot('Pop');
        
        if (target.seatsLeft === 0 && target.runnersInFlight === 0) {
            EventBus.emit(GameEvents.VEHICLE_COMPLTED, target.vehicle)
            this.departVehicle(target);
        }
    }

    private departVehicle(entry: BoardingVehicle): void {
        const index = this.boarding.indexOf(entry);
        if (index < 0) {
            return;
        }
        this.boarding.splice(index, 1);
        this._departing++;
        const started = this.vehicleManager!.departVehicle(entry.vehicle, entry.slot, () => {
            this._departing--;
        });
        if (!started) {
            this._departing--;
            Debug.error(`[BeltManager] Vehicle ${entry.vehicle.data?.id ?? '?'} could not depart.`);
        }
    }

    // ---------- Boarding geometry (SceneLayout) ----------

    /** +1 or -1 along world Z from the parking row toward the belt (Unity's +Z, flipped in this scene). */
    private towardBeltZ(): number {
        const row = this.parkingManager!.slotRowBounds();
        const mouth = this.pickupPoint();
        return row === null || mouth.z <= row.z ? -1 : 1;
    }

    /** The shape's pickup point: the ExitGate node, else the loop point at exitGateCenter. */
    private pickupPoint(): Vector3 {
        return this.exitGate !== null && isAlive(this.exitGate)
            ? this.exitGate.transform.position.clone()
            : this.beltPath!.evaluatePosition(this.wrap01(this.exitGateCenter));
    }

    /** SceneLayout.BoardingMouthPoint: the pickup point plus boardingMouthOffset. */
    private boardingMouthPoint(): Vector3 {
        const pickup = this.pickupPoint();
        return new Vector3(
            pickup.x + this.u(this.boardingMouthOffsetX),
            pickup.y,
            pickup.z + this.u(this.boardingMouthOffsetZ) * this.towardBeltZ(),
        );
    }

    /** SceneLayout.BoardingPoint for boardingPointLocal (0, 1) + boardingPointTowardBelt: the body end facing the belt. */
    private boardingPoint(vehicle: Vehicle, length: number): Vector3 {
        const radians = vehicle.poseYaw * Math.PI / 180;
        const axis = new Vector3(Math.sin(radians), 0, Math.cos(radians));
        let along = length / 2 + this.u(this.boardingPointClearance);
        if (axis.z * along * this.towardBeltZ() < 0) {
            along = -along;
        }
        return V3.scaleAndAdd(new Vector3(), vehicle.posePosition, axis, along);
    }

    /** SceneLayout.StreamExitPoint: the mouth shifted sideways in proportion to the boarding point's x. */
    private streamExitPoint(boardingPoint: Readonly<Vector3>): Vector3 {
        const mouth = this.boardingMouthPoint();
        const row = this.parkingManager!.slotRowBounds();
        const reach = row === null ? 0 : Math.max(Math.abs(row.minX - mouth.x), Math.abs(row.maxX - mouth.x));
        const shift = reach > 0 ? (boardingPoint.x - mouth.x) / reach * this.u(this.streamMouthHalfWidth) : 0;
        return new Vector3(mouth.x + shift, mouth.y, mouth.z);
    }

    /** SceneLayout.StreamLaneOffset. */
    private streamLaneOffset(serial: number): number {
        const count = Math.max(1, Math.floor(this.streamLaneCount));
        const lane = ((serial % count) + count) % count;
        return (lane - (count - 1) / 2) * this.u(this.streamLaneSpacing);
    }

    /** SceneLayout.AppendBoardingStream: exit -> walkway above the boarding point -> boarding point. */
    private appendBoardingStream(boardingPoint: Readonly<Vector3>, laneOffset: number, points: Vector3[]): void {
        const exit = this.streamExitPoint(boardingPoint);
        const row = this.parkingManager!.slotRowBounds();
        const toward = this.towardBeltZ();
        const laneZ = (row?.z ?? boardingPoint.z) + this.u(this.boardingLaneOffsetZ) * toward;
        // Unity: boardingPoint.z < lane, i.e. the boarding point is farther from the belt than the walkway.
        const viaLane = (laneZ - boardingPoint.z) * toward > 0;
        const above = new Vector3(boardingPoint.x, boardingPoint.y, laneZ);
        const run = V3.subtract(new Vector3(), viaLane ? above : boardingPoint, exit);
        run.y = 0;
        const side = run.sqrMagnitude > 0 ? V3.normalize(new Vector3(), new Vector3(-run.z, 0, run.x)) : new Vector3(1, 0, 0);
        V3.multiplyScalar(side, side, laneOffset);
        points.push(V3.add(new Vector3(), exit, side));
        if (viaLane) {
            points.push(V3.add(new Vector3(), above, side));
        }
        points.push(boardingPoint.clone());
    }

    private measure(runner: Runner): void {
        runner.along.length = 0;
        runner.along.push(0);
        runner.runLength = 0;
        for (let i = 1; i < runner.path.length; i++) {
            runner.runLength += V3.distance(runner.path[i - 1], runner.path[i]);
            runner.along.push(runner.runLength);
        }
    }

    // ---------- End rules ----------

    /**
     * Ruleset `end`, in order: win, slotsClogged (`parking_full`), noMoves (`no_exit`).
     * Emits GameEvents.WIN_GAME, or GameEvents.LOSE_GAME with the reason, once per level.
     */
    private checkEnd(): void {
        if (this._ended) {
            return;
        }
        if (this.isWon()) {
            this._ended = true;
            EventBus.emit(GameEvents.WIN_GAME);
            return;
        }
        if (!this.isSettled()) {
            return;
        }
        if (this.parkingManager!.freeSlotCount === 0) {
            // ParkingFullLoseRule: no free slot and nobody left can board.
            this._ended = true;
            EventBus.emit(GameEvents.LOSE_GAME, BeltManager.LOSE_PARKING_FULL);
            return;
        }
        if (!this.vehicleManager!.hasExitableVehicle()) {
            // NoExitLoseRule: a slot is free but no vehicle on the board can leave
            // (an empty board that has not won counts as well).
            this._ended = true;
            EventBus.emit(GameEvents.LOSE_GAME, BeltManager.LOSE_NO_EXIT);
        }
    }

    /**
     * AllBoardedWinRule: nobody waits (queues and belt empty) and no vehicle is
     * parked. The presentation also lets the last runners land and the last
     * vehicle drive away first.
     */
    private isWon(): boolean {
        return this.passengerManager!.totalRemainingGroups === 0
            && this.rows.every((row) => row === null)
            && this.runners.length === 0
            && this.boarding.length === 0
            && this._departing === 0;
    }

    /**
     * Rule "after settle", in presentation terms: no vehicle is moving or leaving,
     * nobody is running, the belt has no hole the queues could still fill, and no
     * parked vehicle with free seats has its color on the belt.
     */
    private isSettled(): boolean {
        if (this._departing > 0 || this.runners.length > 0 || this.vehicleManager!.hasMovingVehicle) {
            return false;
        }
        // Passengers the rules already sent to the belt are still on their way.
        if (this.feedQuota.Left > 0 || this.feedQuota.Right > 0 || this.rows.some((row) => row !== null && row.join !== null)) {
            return false;
        }
        const colors = new Set<number>();
        for (const row of this.rows) {
            if (row !== null) {
                colors.add(row.color);
            }
        }
        return !this.boarding.some((entry) => entry.seatsLeft > 0 && colors.has(entry.color));
    }

    // ---------- Belt geometry ----------

    private placeRow(index: number, row: BeltRow): void {
        const t = this.rowT(index);
        const centre = this.beltPath!.evaluatePosition(t);
        const beltRotation = pathRotation(this.beltPath!, t);
        let position = centre;
        let rotation = beltRotation;
        if (row.join !== null) {
            // Hermite on the offset from the row: from (offset, relative velocity) to (0, 0).
            const join = row.join;
            const u = this.clamp01(join.elapsed / join.duration);
            const h00 = (2 * u - 3) * u * u + 1;
            const h10 = ((u - 2) * u + 1) * u;
            position = V3.scaleAndAdd(new Vector3(), centre, join.fromOffset, h00);
            V3.scaleAndAdd(position, position, join.fromVelocity, h10 * join.duration);
            rotation = quatSlerp(join.fromRotation, beltRotation, u);
        }
        const across = V3.transformQuat(new Vector3(), Vector3.right, rotation);
        const spacing = this.figureSpacingOverride > 0 ? this.figureSpacingOverride : this.u(BeltManager.UNITY_FIGURE_CELL);
        const count = row.figures.length;
        row.figures.forEach((figure, figureIndex) => {
            if (row.gone[figureIndex] || !isAlive(figure)) {
                return;
            }
            figure.transform.position = V3.scaleAndAdd(new Vector3(), position, across, (figureIndex - (count - 1) / 2) * spacing);
            // SplineContainer regards local +Z as forward. If the Boy model faces
            // backwards, rotate its visual child 180 degrees rather than the path.
            figure.transform.rotation = rotation;
        });
    }

    private rowT(index: number): number {
        return this.wrap01(this._phase + (index + 0.5) / this.rows.length);
    }

    private previousRowT(index: number): number {
        return this.wrap01(this._previousPhase + (index + 0.5) / this.rows.length);
    }

    /** BeltCrowd.IsAtExitGate: inside the gate, or the last drift touched it. */
    private isAtExitGate(index: number): boolean {
        if (this.exitGate !== null && isAlive(this.exitGate)) {
            const position = this.beltPath!.evaluatePosition(this.rowT(index));
            if (this.exitGate.containsPoint(position)) {
                return true;
            }
            return this.exitGate.intersectsSegment(this.beltPath!.evaluatePosition(this.previousRowT(index)), position);
        }
        const half = this.exitGateLength / 2;
        const start = this.wrap01(this.exitGateCenter - half);
        const end = this.wrap01(this.exitGateCenter + half);
        return this.inArc(this.rowT(index), start, end) || this.sweptPast(index, start);
    }

    /** The row passed `x` during the last belt drift. */
    private sweptPast(index: number, x: number): boolean {
        const from = this.previousRowT(index);
        const travelled = this.aheadOf(from, this.rowT(index));
        const distance = this.aheadOf(from, this.wrap01(x));
        return distance > 0 && distance <= travelled;
    }

    private inArc(t: number, start: number, end: number): boolean {
        return this.aheadOf(start, t) <= this.aheadOf(start, end);
    }

    /** Fraction of the loop from `from` forward to `to`, in [0, 1). */
    private aheadOf(from: number, to: number): number {
        return this.wrap01(to - from);
    }

    /** SceneLayout.QueueJoinT: the loop t nearest to the queue path's end, else the Inspector value. */
    private joinT(side: PassengerQueueSide, passengers: PassengerManager | null = this.passengerManager): number {
        // The paths do not move during a level: reuse the value computed in initialize().
        const cached = passengers === this.passengerManager ? this.joinTCache[side] : undefined;
        if (cached !== undefined) {
            return cached;
        }
        const point = passengers?.queueJoinPoint(side) ?? null;
        if (point !== null) {
            const nearest = this.beltPath!.getNearestPoint(point);
            if (nearest !== null) {
                return this.wrap01(nearest.t);
            }
        }
        return this.wrap01(side === 'Left' ? this.leftJoinT : this.rightJoinT);
    }

    /** SceneLayout.QueueJoinPoint: the queue path's end, else the loop point at the join t. */
    private queueJoinPoint(side: PassengerQueueSide): Vector3 {
        return this.passengerManager?.queueJoinPoint(side) ?? this.beltPath!.evaluatePosition(this.joinT(side));
    }

    /** Scene units per second of belt drift at factor 1. */
    private beltSpeed(): number {
        const target = this.endSpeed > 0 ? this.endSpeed : this.speed;
        return this.u(this.speed + (target - this.speed) * this._endBlend);
    }

    /** PresentationContext.BeltSpeedPerPassengerSecond: belt drift per second of the passenger clock. */
    private beltSpeedPerPassengerSecond(): number {
        const crowd = Pacing.crowd > 0 ? Pacing.crowd : 1;
        const belt = Pacing.belt > 0 ? Pacing.belt : 1;
        return this.beltSpeed() * belt / crowd;
    }

    private groupCenter(figures: readonly GameObject[]): Vector3 | null {
        if (figures.length === 0) {
            return null;
        }
        const center = new Vector3();
        for (const figure of figures) {
            V3.add(center, center, figure.transform.position);
        }
        return V3.multiplyScalar(center, center, 1 / figures.length);
    }

    /** A Unity world-space distance (or speed) in scene units. */
    private u(value: number): number {
        return value * this._unit;
    }

    private clamp01(value: number): number {
        return Math.max(0, Math.min(1, value));
    }

    private wrap01(value: number): number {
        return value - Math.floor(value);
    }

    private resolveCapacity(levelData: LevelData): number {
        if (this.capacityOverride > 0) {
            return Math.floor(this.capacityOverride);
        }
        const fromLevel = BeltManager.LOOP_CAPACITY[levelData.passengers.loop_model];
        if (fromLevel === undefined) {
            Debug.error(`[BeltManager] Unknown loop_model '${levelData.passengers.loop_model}'; using 32.`);
            return 32;
        }
        return fromLevel;
    }

    private clearAll(): void {
        for (const row of this.rows) {
            row?.figures.forEach((figure) => isAlive(figure) && this.destroy(figure));
        }
        for (const runner of this.runners) {
            const node = runner.row.figures[runner.figure];
            if (isAlive(node)) {
                this.destroy(node);
            }
        }
        this.rows = [];
        this.runners.length = 0;
        this.boarding.length = 0;
        this._departing = 0;
    }

    onDrawGizmos(): void {
        if (this.beltPath === null) {
            return;
        }
        if (this.exitGate === null) {
            // The ExitGate node draws its own box.
            const half = this.exitGateLength / 2;
            Gizmos.color = GIZMO_GREEN;
            Gizmos.drawWireSphere(this.beltPath.evaluatePosition(this.wrap01(this.exitGateCenter - half)), 0.15);
            Gizmos.drawWireSphere(this.beltPath.evaluatePosition(this.wrap01(this.exitGateCenter + half)), 0.15);
        }
        // Join points actually used: from the queue paths when PassengerManager has them.
        const passengers = this.passengerManager ?? this.gameObject.scene?.findObjectOfType(PassengerManager, true) ?? null;
        Gizmos.color = GIZMO_CYAN;
        Gizmos.drawWireSphere(this.beltPath!.evaluatePosition(this.joinT('Left', passengers)), 0.2);
        Gizmos.color = GIZMO_MAGENTA;
        Gizmos.drawWireSphere(this.beltPath!.evaluatePosition(this.joinT('Right', passengers)), 0.2);
    }
}
