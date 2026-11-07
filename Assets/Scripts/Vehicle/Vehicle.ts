import { Color, field, Material, MeshRenderer, MonoBehaviour, Quaternion, SpriteRenderer, Vector3, type IPointerClickHandler, type PointerEventData } from '@pia/core';
import { VehicleData } from '../Data/LevelData';
import { ServiceLocator } from '../ServiceLocator';
import { ColorConfigSO } from '../Data/ColorConfigSO';
import { EventBus } from '../EventBus';
import { GameEvents } from '../GameEvents';

export enum VehicleKind {
    Car = 'car',
    Van = 'van',
    Bus = 'bus',
}

/** Local +Z: the visual nose of a vehicle. */
const NOSE = new Vector3(0, 0, 1);

export class Vehicle extends MonoBehaviour implements IPointerClickHandler {
    @field(MeshRenderer) renderer: MeshRenderer | null = null;
    @field(SpriteRenderer) mask: SpriteRenderer | null = null;
    /** Direction mask alpha (0-255) while this vehicle's exit is blocked; restored to 255 once clear. */
    @field({ range: [0, 255] }) blockedMaskAlpha: number = 100;
    private isBlocked = false;
    /** The entry in the current level which created this view. */
    @field(VehicleData) data: VehicleData | null = null;
    public kind: VehicleKind = VehicleKind.Car;
    /** Managed by VehicleManager while this vehicle is travelling to a parking slot. */
    public isMoving: boolean = false;
    /** A parked vehicle stays in its claimed slot and can no longer be tapped. */
    public isParked: boolean = false;
    /** Tapped successfully: no longer part of the board (logic VehicleLeftBoard). */
    public leftBoard: boolean = false;

    /**
     * GD stores visible figures (16/24/40). BusGo groups four figures into
     * one belt-row/seat token, so the rule capacities are 4/6/10.
     */
    public get capacity(): number {
        return Math.max(0, Math.floor((this.data?.seats ?? 0) / 4));
    }

    // ---------- VehicleView body: pose + scale layers ----------

    /** World pose without impact layers. Yaw: degrees about +Y, visual nose = local +Z. */
    public readonly posePosition = new Vector3();
    public poseYaw = 0;
    public poseRoll = 0;
    public posePitch = 0;
    /** Extra yaw from tail drift, already included in poseYaw. */
    public driftYaw = 0;
    /** Positive: wider and lower; negative: thinner and taller. */
    private squash = 0;
    private boardPop = 0;
    private boardPopVelocity = 0;
    private boardPopKicks = 0;
    private readonly baseScale = new Vector3(1, 1, 1);
    private readonly impacts = new Map<string, { offset: Vector3; tilt: Quaternion; compression: number }>();

    initialize(data: VehicleData, kind: VehicleKind): void {
        this.data = data;
        this.kind = kind;
        this.gameObject.name = `${kind}_${data.id}`;
        this.baseScale.copy(this.transform.localScale);
        this.captureCurrentPose();
        this.setMaskVisible(true);

        const config = ServiceLocator.get(ColorConfigSO);
        const color = config.colors[data.color];
        const shadowColor = config.shadowColors[data.color];
        // Cocos set per-vehicle colours as instanced vertex attributes on the shared Car material.
        // PiaEngine has no per-instance attributes yet: vehicles share one material per colour
        // (see colorMaterial), so with "Enable GPU Instancing" on the Car material every
        // same-mesh, same-colour vehicle is still drawn in one draw call.
        if (this.renderer && color && shadowColor) {
            const mat = Vehicle.colorMaterial(this.renderer, data.color, color, shadowColor);
            if (mat) this.renderer.sharedMaterial = mat;
        }
    }

    /** One material per (source material, colour index), shared by every vehicle of that colour. */
    private static readonly colorMaterials = new Map<Material, Map<number, Material>>();

    private static colorMaterial(renderer: MeshRenderer, index: number, color: Color, shadowColor: Color): Material | null {
        // the material the prefab was set up with (an already-coloured copy maps back to its source)
        let source = renderer.sharedMaterial;
        if (!source || !source.shader) return null;
        for (const [src, byColor] of Vehicle.colorMaterials) {
            for (const m of byColor.values()) if (m === source) source = src;
        }
        let byColor = Vehicle.colorMaterials.get(source);
        if (!byColor) Vehicle.colorMaterials.set(source, (byColor = new Map()));
        let mat = byColor.get(index);
        if (!mat) {
            mat = Material.create(source.shader!);
            mat.copyPropertiesFromMaterial(source);
            mat.enableInstancing = source.enableInstancing;
            mat.name = `${source.name} (color ${index})`;
            mat.setColor('_Color', color);
            mat.setColor('_ShadowColor', shadowColor);
            byColor.set(index, mat);
        }
        return mat;
    }

    /** Shows or hides the direction mask sprite (hidden once the vehicle is parked in a slot). */
    setMaskVisible(visible: boolean): void {
        if (this.mask !== null) {
            this.mask.enabled = visible;
        }
    }

    /** Dims the direction mask while the exit is blocked; restores it to full opacity once clear. */
    setBlocked(blocked: boolean): void {
        if (this.mask === null || this.isBlocked === blocked) {
            return;
        }
        this.isBlocked = blocked;
        const color = this.mask.color.clone();
        color.a = blocked ? this.blockedMaskAlpha / 255 : 1; // PiaEngine colours are 0..1
        this.mask.color = color;
    }

    /** Reads the object's current world transform into the pose (spawn, or after an external move). */
    captureCurrentPose(): void {
        this.posePosition.copy(this.transform.position);
        const nose = this.transform.rotation.mulVector3(NOSE);
        this.poseYaw = Math.atan2(nose.x, nose.z) * 180 / Math.PI;
        this.poseRoll = 0;
        this.posePitch = 0;
        this.driftYaw = 0;
    }

    /** VehicleView.SetPose: rotation = yaw * pitch(X, + is nose down) * roll(Z). */
    setPose(position: Readonly<Vector3>, yaw: number, roll = 0, pitch = 0): void {
        this.posePosition.copy(position);
        this.poseYaw = yaw;
        this.poseRoll = roll;
        this.posePitch = pitch;
        this.applyTransform();
    }

    setSquash(amount: number): void {
        this.squash = amount;
        this.applyScale();
    }

    /** A figure just reached the vehicle: kick the board pop on the next advance (kicks add up). */
    kickBoardPop(): void {
        this.boardPopKicks++;
    }

    /** VehicleView.AdvanceBoardPop: damped spring; each kick adds the velocity that would reach `amount` undamped. */
    advanceBoardPop(seconds: number, amount: number, frequency: number, damping: number): void {
        const omega = 2 * Math.PI * frequency;
        if (this.boardPopKicks > 0) {
            this.boardPopVelocity += this.boardPopKicks * amount * omega;
            this.boardPopKicks = 0;
        }
        if (this.boardPop === 0 && this.boardPopVelocity === 0) {
            return;
        }
        const steps = Math.max(1, Math.ceil(seconds * 240));
        const h = seconds / steps;
        for (let i = 0; i < steps; i++) {
            this.boardPopVelocity += (-omega * omega * this.boardPop - 2 * damping * omega * this.boardPopVelocity) * h;
            this.boardPop += this.boardPopVelocity * h;
        }
        if (Math.abs(this.boardPop) < 1e-4 && Math.abs(this.boardPopVelocity) < 1e-4 * omega) {
            this.boardPop = 0;
            this.boardPopVelocity = 0;
        }
        this.applyScale();
    }

    /** VehicleView.SetImpact: one additive layer per owner (offset, world tilt, length compression). */
    setImpact(owner: string, offset: Readonly<Vector3>, tilt: Readonly<Quaternion>, compression: number): void {
        const layer = this.impacts.get(owner);
        if (layer === undefined) {
            this.impacts.set(owner, { offset: offset.clone(), tilt: tilt.clone(), compression });
        } else {
            layer.offset.copy(offset);
            layer.tilt.copy(tilt);
            layer.compression = compression;
        }
        this.applyTransform();
        this.applyScale();
    }

    clearImpact(owner: string): void {
        if (this.impacts.delete(owner)) {
            this.applyTransform();
            this.applyScale();
        }
    }

    private applyTransform(): void {
        let offset = new Vector3();
        let tilt = Quaternion.identity;
        for (const layer of this.impacts.values()) {
            offset = offset.add(layer.offset);
            tilt = layer.tilt.multiply(tilt);
        }
        // yaw * pitch * roll (each about one axis, so the Euler order doesn't matter)
        const rotation = Quaternion.euler(0, this.poseYaw, 0)
            .multiply(Quaternion.euler(this.posePitch, 0, 0))
            .multiply(Quaternion.euler(0, 0, this.poseRoll));
        this.transform.position = this.posePosition.add(offset);
        this.transform.rotation = tilt.multiply(rotation); // impact tilt is in world space
    }

    private applyScale(): void {
        let compression = 0;
        for (const layer of this.impacts.values()) {
            compression += layer.compression;
        }
        const spread = compression / 2;
        const size = 1 + this.boardPop;
        this.transform.setLocalScale(
            this.baseScale.x * size * (1 + this.squash + spread),
            this.baseScale.y * size * (1 - this.squash),
            this.baseScale.z * size * (1 + this.squash) * (1 - compression),
        );
    }

    onPointerClick(eventData: PointerEventData): void {
        if (this.isMoving || this.isParked) {
            return;
        }
        // Where the click hit the vehicle (PhysicsRaycaster), else its centre.
        const hit = eventData.pointerPressRaycast;
        const clickPoint = hit.isValid ? hit.worldPosition.clone() : this.transform.position;
        EventBus.emit(GameEvents.CAR_CLICK, this, clickPoint);
    }
}
