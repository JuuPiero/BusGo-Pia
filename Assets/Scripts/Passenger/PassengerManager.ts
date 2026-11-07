import { Color, Debug, field, foldoutGroup, GameObject, Gizmos, isAlive, MonoBehaviour, Quaternion, Time, Vector3 } from '@pia/core';
import { SplineContainer } from 'com.pia.spline';
import { ServiceLocator } from '../ServiceLocator';
import { GameConfiSO } from '../GameConfigSO';
import { LevelData, PassengerGroupData } from '../Data/LevelData';
import { MotionCurves } from '../Data/MotionCurves';
import { Pacing } from '../Pacing';
import { V3 } from '../Utils/CocosMath';
import { pathDirection, pathLength, pathRotation } from '../Utils/CocosSpline';
import { Passenger } from './Passenger';

export type PassengerQueueSide = 'Left' | 'Right';

interface VisiblePassengerGroup {
    color: number;
    figures: GameObject[];
}

interface PassengerQueueState {
    side: PassengerQueueSide;
    root: GameObject | null;
    /** One entry per logical passenger token; every token represents four GD figures. */
    groupColors: number[];
    /** Spawned prefix of groupColors. The hidden tail remains in groupColors. */
    visibleGroups: VisiblePassengerGroup[];
    /** QueueStepCommands still to play; they run one after another on the queue track. */
    pendingSteps: number;
    /** Progress 0..1 of the step currently playing. */
    stepProgress: number;
    /** Queue branch path (tail -> join on the belt); null uses the straight layout under `root`. */
    path: SplineContainer | null;
}

/** A pose on a queue branch: position and facing toward the join. */
interface QueuePose {
    position: Vector3;
    rotation: Quaternion;
}

const GROUP_QUEUES = 'Queues';
const GROUP_PATH = 'Queue Path';
const GROUP_STEP = 'Queue Step';

/** Cocos Color.BLUE / MAGENTA / YELLOW / CYAN (PiaEngine colours are 0..1). */
const GIZMO_BLUE = new Color(0, 0, 1, 1);
const GIZMO_MAGENTA = new Color(1, 0, 1, 1);
const GIZMO_YELLOW = new Color(1, 1, 0, 1);
const GIZMO_CYAN = new Color(0, 1, 1, 1);

/**
 * Owns the two complete passenger queues.
 *
 * GD stores raw figure counts (16/24/40 figures per vehicle). Gameplay treats
 * every four same-color figures as one logical passenger token. Only a bounded
 * prefix is instantiated; hidden groups are spawned lazily as visible head
 * groups leave, so the visual cap never truncates gameplay data.
 */
export class PassengerManager extends MonoBehaviour {
    private static readonly FIGURES_PER_GROUP = 4;

    /** Parent of the generated figures of each queue (also the straight-layout origin without a path). */
    @foldoutGroup(GROUP_QUEUES) @field(GameObject)
    leftQueueRoot: GameObject | null = null;

    @foldoutGroup(GROUP_QUEUES) @field(GameObject)
    rightQueueRoot: GameObject | null = null;

    /**
     * Maximum number of instantiated figures per queue. The value is rounded
     * down to complete four-figure groups. Set 0 to instantiate the full queue.
     * Ignored for a queue with a path when fitVisibleToPath is on.
     */
    @foldoutGroup(GROUP_QUEUES)
    maxVisiblePerQueue: number = 24;

    /** Number of figure columns used by the queue layout. */
    @foldoutGroup(GROUP_QUEUES) @field({ type: 'int', label: 'Số khách 1 hàng ngang' })
    figuresPerRow: number = 4;

    /** Distance between the figures of a row, across the queue. */
    @foldoutGroup(GROUP_QUEUES) @field({ label: 'Khoảng cách hàng ngang của khách trên đường phụ' })
    figureSpacing: number = 0.24;

    /** Distance between two rows along the queue (SceneLayout.QueueRowSpacing in this scene). */
    @foldoutGroup(GROUP_QUEUES) @field({ label: 'Khoảng cách giữa 2 hàng ngang của khách trên đường phụ' })
    rowSpacing: number = 0.3;

    /**
     * QueueBranchPath of each queue: draw it from the tail of the line to the
     * point where it joins the belt loop (the last knot sits on the belt). Rows
     * are laid out from the join backwards; past the first knot the line goes on
     * straight. Empty: the old straight layout under the queue root.
     */
    @foldoutGroup(GROUP_PATH) @field(SplineContainer)
    leftQueuePath: SplineContainer | null = null;

    @foldoutGroup(GROUP_PATH) @field(SplineContainer)
    rightQueuePath: SplineContainer | null = null;

    /** SceneLayout.queueHeadOffset: distance along the path from the join to the head row. */
    @foldoutGroup(GROUP_PATH)
    queueHeadOffset: number = 0.6;

    /** With a path, show as many rows as fit on it (instead of maxVisiblePerQueue). */
    @foldoutGroup(GROUP_PATH)
    fitVisibleToPath: boolean = true;

    /** MotionTuning.queueStepSpeed (Unity units/second). */
    @foldoutGroup(GROUP_STEP)
    queueStepSpeed: number = 1.8;

    /**
     * Unity SceneLayout.QueueRowSpacing for the standard theme (MapLoopShape:
     * cell 0.1039 * crowdQueueRowRatio 1.75). A step lasts this / queueStepSpeed
     * seconds of the feed clock, whatever `rowSpacing` is in this scene.
     */
    @foldoutGroup(GROUP_STEP)
    unityQueueRowSpacing: number = 0.1818;

    private passengerPrefab: GameObject | null = null;
    private readonly leftState: PassengerQueueState = this.createState('Left');
    private readonly rightState: PassengerQueueState = this.createState('Right');

    initialize(levelData: LevelData): void {
        // The scene may keep this branch disabled until a playable level starts.
        this.gameObject.setActive(true);

        const prefab = ServiceLocator.get(GameConfiSO).passengerPrefab;
        if (prefab === null) {
            Debug.error('[PassengerManager] GameConfiSO.passengerPrefab is not assigned.');
            return;
        }
        if (this.leftQueueRoot === null || this.rightQueueRoot === null) {
            Debug.error('[PassengerManager] Assign both leftQueueRoot and rightQueueRoot in the Inspector.');
            return;
        }

        this.passengerPrefab = prefab;
        this.leftState.path = this.usablePath(this.leftQueuePath);
        this.rightState.path = this.usablePath(this.rightQueuePath);
        this.resetQueue(this.leftState, levelData.passengers.left, this.leftQueueRoot);
        this.resetQueue(this.rightState, levelData.passengers.right, this.rightQueueRoot);
    }

    /** True when the side still has a complete four-figure token waiting. */
    public hasWaitingGroup(side: PassengerQueueSide): boolean {
        return this.stateOf(side).groupColors.length > 0;
    }

    /** Number of complete logical passenger tokens still waiting on one side. */
    public remainingGroupCount(side: PassengerQueueSide): number {
        return this.stateOf(side).groupColors.length;
    }

    /** Total complete logical passenger tokens still waiting in both queues. */
    public get totalRemainingGroups(): number {
        return this.leftState.groupColors.length + this.rightState.groupColors.length;
    }

    /**
     * Removes the first logical passenger token and reparents its four
     * same-color figures. Returns an empty array when that queue is exhausted.
     */
    public takeNextPassengerGroup(side: PassengerQueueSide, newParent: GameObject): GameObject[] {
        const state = this.stateOf(side);
        if (state.groupColors.length === 0) {
            return [];
        }

        // A positive visual cap always reserves at least the head group, but
        // recover here as well if the Inspector value changed at runtime.
        if (state.visibleGroups.length === 0) {
            this.fillVisiblePrefix(state);
        }

        const visualGroup = state.visibleGroups.shift();
        if (visualGroup === undefined) {
            Debug.error(`[PassengerManager] ${side} queue has data but no visible head group.`);
            return [];
        }

        const expectedColor = state.groupColors.shift();
        if (expectedColor !== visualGroup.color) {
            Debug.error(
                `[PassengerManager] ${side} queue visual color ${visualGroup.color} does not match data color ${expectedColor}.`,
            );
        }

        for (const figure of visualGroup.figures) {
            // Keep the world pose so the belt can animate the walk from the queue head.
            figure.transform.setParent(newParent.transform, true);
        }

        // The rest of the line keeps its place and steps up one row (QueueStepCommand).
        state.pendingSteps++;
        this.fillVisiblePrefix(state);
        this.layoutQueue(state);
        return visualGroup.figures;
    }

    /** Color of the next logical passenger token, or null when that queue is exhausted. */
    public peekNextColor(side: PassengerQueueSide): number | null {
        return this.stateOf(side).groupColors[0] ?? null;
    }

    /** Figures of the current head token (still standing in the queue), or an empty array. */
    public headFigures(side: PassengerQueueSide): readonly GameObject[] {
        return this.stateOf(side).visibleGroups[0]?.figures ?? [];
    }

    /** SceneLayout.QueueJoinPoint: where the queue's path meets the belt, or null without a path. */
    public queueJoinPoint(side: PassengerQueueSide): Vector3 | null {
        const path = this.usablePath(this.pathOf(side));
        return path !== null ? path.evaluatePosition(1) : null;
    }

    /** SceneLayout.QueueHeadDistance: path distance from the join to the head row, or null without a path. */
    public queueHeadDistance(side: PassengerQueueSide): number | null {
        return this.usablePath(this.pathOf(side)) !== null ? this.queueHeadOffset : null;
    }

    /** Some queue is still stepping forward (Unity's Queue track is active). */
    public get isStepping(): boolean {
        return this.leftState.pendingSteps > 0 || this.rightState.pendingSteps > 0;
    }

    update(): void {
        const deltaTime = Time.deltaTime;
        // Queue steps run on the feed clock: max(crowd, belt) factor.
        Pacing.advance(deltaTime);
        const duration = this.unityQueueRowSpacing / Math.max(0.0001, this.queueStepSpeed);
        const elapsed = deltaTime * Pacing.feed;
        for (const state of [this.leftState, this.rightState]) {
            if (state.pendingSteps <= 0) {
                continue;
            }
            state.stepProgress += duration > 0 ? elapsed / duration : 1;
            while (state.stepProgress >= 1 && state.pendingSteps > 0) {
                state.stepProgress -= 1;
                state.pendingSteps--;
            }
            if (state.pendingSteps === 0) {
                state.stepProgress = 0;
            }
            this.layoutQueue(state);
        }
    }

    private createState(side: PassengerQueueSide): PassengerQueueState {
        return {
            side,
            root: null,
            groupColors: [],
            visibleGroups: [],
            pendingSteps: 0,
            stepProgress: 0,
            path: null,
        };
    }

    private pathOf(side: PassengerQueueSide): SplineContainer | null {
        return side === 'Left' ? this.leftQueuePath : this.rightQueuePath;
    }

    /** A path with at least one curve (two knots); anything else falls back to the straight layout. */
    private usablePath(path: SplineContainer | null): SplineContainer | null {
        return path !== null && isAlive(path) && pathLength(path) > 0.0001 ? path : null;
    }

    /**
     * QueueBranchPath.EvaluateFromJoin: the pose `distance` back from the join
     * (the path's end), facing toward the join; past the first knot the line
     * carries on straight along the start direction.
     */
    private poseFromJoin(path: SplineContainer, length: number, distance: number): QueuePose {
        if (distance <= length) {
            const t = Math.max(0, Math.min(1, 1 - distance / length));
            return { position: path.evaluatePosition(t), rotation: pathRotation(path, t) };
        }
        const start = path.evaluatePosition(0);
        const direction = pathDirection(path, 0);
        return {
            position: V3.scaleAndAdd(new Vector3(), start, direction, -(distance - length)),
            rotation: pathRotation(path, 0),
        };
    }

    private stateOf(side: PassengerQueueSide): PassengerQueueState {
        return side === 'Left' ? this.leftState : this.rightState;
    }

    private resetQueue(state: PassengerQueueState, groups: PassengerGroupData[], root: GameObject): void {
        // Cocos root.destroyAllChildren(): destroyed at the end of the frame.
        for (const child of root.transform.children) {
            this.destroy(child.gameObject);
        }
        state.root = root;
        state.groupColors.length = 0;
        state.visibleGroups.length = 0;
        state.pendingSteps = 0;
        state.stepProgress = 0;

        for (const group of groups) {
            const rawFigureCount = Math.max(0, Math.floor(group.count));
            const completeGroups = Math.floor(rawFigureCount / PassengerManager.FIGURES_PER_GROUP);
            if (rawFigureCount % PassengerManager.FIGURES_PER_GROUP !== 0) {
                Debug.error(
                    `[PassengerManager] ${state.side} color ${group.color} has ${rawFigureCount} figures; `
                    + `GD counts must be divisible by ${PassengerManager.FIGURES_PER_GROUP}.`,
                );
            }
            for (let index = 0; index < completeGroups; index++) {
                state.groupColors.push(group.color);
            }
        }

        this.fillVisiblePrefix(state);
        this.layoutQueue(state);
    }

    private fillVisiblePrefix(state: PassengerQueueState): void {
        if (state.root === null || this.passengerPrefab === null) {
            return;
        }

        const target = Math.min(state.groupColors.length, this.visibleGroupLimit(state, state.groupColors.length));
        while (state.visibleGroups.length < target) {
            const visibleIndex = state.visibleGroups.length;
            const color = state.groupColors[visibleIndex];
            state.visibleGroups.push(this.spawnGroup(state, color, visibleIndex));
        }
    }

    private visibleGroupLimit(state: PassengerQueueState, totalGroups: number): number {
        if (state.path !== null && this.fitVisibleToPath && this.rowSpacing > 0) {
            // SceneLayout.QueueWindow: every row that stands on the path.
            const room = pathLength(state.path) - this.queueHeadOffset;
            return Math.max(1, Math.floor(room / this.rowSpacing) + 1);
        }
        if (this.maxVisiblePerQueue <= 0) {
            return totalGroups;
        }
        const figureLimit = Math.max(
            PassengerManager.FIGURES_PER_GROUP,
            Math.floor(this.maxVisiblePerQueue),
        );
        return Math.max(1, Math.floor(figureLimit / PassengerManager.FIGURES_PER_GROUP));
    }

    private spawnGroup(
        state: PassengerQueueState,
        color: number,
        visibleGroupIndex: number,
    ): VisiblePassengerGroup {
        const figures: GameObject[] = [];
        for (let figureIndex = 0; figureIndex < PassengerManager.FIGURES_PER_GROUP; figureIndex++) {
            const queuePosition = visibleGroupIndex * PassengerManager.FIGURES_PER_GROUP + figureIndex;
            // Cocos instantiate + setParent(root): the prefab's local transform is kept under root.
            const go = this.instantiate(this.passengerPrefab!, state.root!.transform);

            const passenger = go.getComponent(Passenger) ?? go.addComponent(Passenger);
            passenger.initialize(color, state.side, queuePosition);
            figures.push(go);
        }
        return { color, figures };
    }

    private layoutQueue(state: PassengerQueueState): void {
        const figuresPerRow = Math.max(1, Math.floor(this.figuresPerRow));
        // Rows not yet stepped up are still drawn behind their final place.
        const lag = state.pendingSteps > 0
            ? state.pendingSteps - MotionCurves.queueStep.evaluate(state.stepProgress)
            : 0;
        if (state.path !== null) {
            this.layoutQueueOnPath(state, state.path, lag);
            return;
        }
        let queuePosition = 0;
        for (const group of state.visibleGroups) {
            for (const figure of group.figures) {
                this.setQueuePosition(figure, queuePosition, figuresPerRow, lag);
                queuePosition++;
            }
        }
    }

    /**
     * QueueView.Refresh on a branch path: row i stands queueHeadOffset + (i + lag)
     * rows back from the join, its figures side by side across the path, all
     * facing the join.
     */
    private layoutQueueOnPath(state: PassengerQueueState, path: SplineContainer, lag: number): void {
        const length = pathLength(path);
        state.visibleGroups.forEach((group, row) => {
            const pose = this.poseFromJoin(path, length, this.queueHeadOffset + (row + lag) * this.rowSpacing);
            const across = V3.transformQuat(new Vector3(), Vector3.right, pose.rotation);
            const count = group.figures.length;
            group.figures.forEach((figure, column) => {
                figure.transform.position = V3.scaleAndAdd(new Vector3(), pose.position, across, (column - (count - 1) / 2) * this.figureSpacing);
                figure.transform.rotation = pose.rotation;
            });
        });
    }

    private setQueuePosition(go: GameObject, queuePosition: number, figuresPerRow: number, rowLag = 0): void {
        const row = Math.floor(queuePosition / figuresPerRow) + rowLag;
        const column = queuePosition % figuresPerRow;
        const x = (column - (figuresPerRow - 1) / 2) * this.figureSpacing;
        // Rows extend along local -Z. Rotate/move the queue root in the Scene
        // to point the waiting line toward the future belt entrance.
        go.transform.setLocalPosition(x, 0, -row * this.rowSpacing);
    }

    /**
     * Scene view. With a path: the join (magenta), the head row (yellow) and the
     * other rows that fit (cyan), each row as a line across the queue. Without a
     * path: the queue root as before.
     */
    onDrawGizmos(): void {
        for (const side of ['Left', 'Right'] as PassengerQueueSide[]) {
            const path = this.usablePath(this.pathOf(side));
            const root = side === 'Left' ? this.leftQueueRoot : this.rightQueueRoot;
            if (path === null) {
                if (root !== null) {
                    Gizmos.color = GIZMO_BLUE;
                    Gizmos.drawWireSphere(root.transform.position, 0.5);
                }
                continue;
            }
            const length = pathLength(path);
            Gizmos.color = GIZMO_MAGENTA;
            Gizmos.drawWireSphere(path.evaluatePosition(1), 0.2);
            const rows = this.rowSpacing > 0 ? Math.max(1, Math.floor((length - this.queueHeadOffset) / this.rowSpacing) + 1) : 1;
            const half = (Math.max(1, Math.floor(this.figuresPerRow)) - 1) / 2 * this.figureSpacing;
            for (let row = 0; row < rows; row++) {
                const pose = this.poseFromJoin(path, length, this.queueHeadOffset + row * this.rowSpacing);
                const across = V3.transformQuat(new Vector3(), Vector3.right, pose.rotation);
                Gizmos.color = row === 0 ? GIZMO_YELLOW : GIZMO_CYAN;
                Gizmos.drawLine(
                    V3.scaleAndAdd(new Vector3(), pose.position, across, -half),
                    V3.scaleAndAdd(new Vector3(), pose.position, across, half),
                );
            }
        }
    }
}
