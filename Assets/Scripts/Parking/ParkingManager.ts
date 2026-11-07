import { Color, Debug, field, GameObject, Gizmos, Handles, MonoBehaviour, Vector3 } from '@pia/core';
import { ServiceLocator } from '../ServiceLocator';
import { GameConfiSO } from '../GameConfigSO';
import { Slot } from './Slot';

/** Cocos Color.YELLOW (PiaEngine colours are 0..1). */
const GIZMO_YELLOW = new Color(1, 1, 0, 1);

export class ParkingManager extends MonoBehaviour {
  spacing: number = 1;
  count: number = 5;
  @field(GameObject) container: GameObject | null = null;

  /**
   * SceneLayout.slotYaw in this scene: the Y value shown on the Slot prefab's
   * rotation (-20). VehicleManager builds the reverse-in and departure legs along
   * the slanted slot axis and parks the car on it. 0 = straight slots.
   */
  slotYaw: number = -20;

  /** Scene view: a car body (0.94 x 1.6) at each slot with the parked yaw, to match the slot art. */
  drawSlotGizmos: boolean = true;

  private spawnedSlots: GameObject[] = [];

  /**
   * World yaw (degrees about +Y) of a parked car. The Slot prefab lies flat with
   * rotation X -90, so its Inspector Y reads mirrored seen from above.
   */
  public get parkedYaw(): number {
    return -this.slotYaw;
  }

  initialize(): void {
    const slotPrefab = ServiceLocator.get(GameConfiSO).slotPrefab;
    if (slotPrefab === null) {
      Debug.error('[ParkingManager] GameConfiSO.slotPrefab is not assigned.');
      return;
    }

    const root = this.container ?? this.gameObject;
    this.clearSlots(root);

    const slotCount = Math.max(0, Math.floor(this.count));
    // Center the row on the container: count=5, spacing=1 -> x = -2..2.
    const firstX = -((slotCount - 1) * this.spacing) / 2;
    for (let index = 0; index < slotCount; index++) {
      // Cocos instantiate + setParent(root): the prefab's local rotation/scale is kept under root.
      const go = this.instantiate(slotPrefab, root.transform);
      go.transform.setLocalPosition(firstX + index * this.spacing, 0, 0);

      const slot = go.getComponent(Slot) ?? go.addComponent(Slot);
      slot.initialize(index);
      this.spawnedSlots.push(go);
    }
  }

  /** The first visible free slot, without reserving it yet. */
  public firstFreeSlot(): Slot | null {
    for (const go of this.spawnedSlots) {
      const slot = go.getComponent(Slot);
      if (slot !== null && !slot.isOccupied) {
        return slot;
      }
    }
    return null;
  }

  /** Reserve a specific free slot immediately before its vehicle starts moving. */
  public tryClaimSlot(slot: Slot, vehicle: GameObject): boolean {
    return this.spawnedSlots.includes(slot.gameObject) && slot.tryClaim(vehicle);
  }

  /** Release a reservation, but only when `vehicle` is the current occupant. */
  public releaseSlot(slot: Slot, vehicle: GameObject): boolean {
    return this.spawnedSlots.includes(slot.gameObject) && slot.release(vehicle);
  }

  /** World-space extent of the slot row (SceneLayout.ParkingArea), half a spacing past the end slots. */
  public slotRowBounds(): { minX: number; maxX: number; z: number } | null {
    if (this.spawnedSlots.length === 0) {
      return null;
    }
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let z = 0;
    for (const go of this.spawnedSlots) {
      const position = go.transform.position;
      minX = Math.min(minX, position.x);
      maxX = Math.max(maxX, position.x);
      z += position.z;
    }
    const half = this.spacing / 2;
    return { minX: minX - half, maxX: maxX + half, z: z / this.spawnedSlots.length };
  }

  public get slotCount(): number {
    return this.spawnedSlots.length;
  }

  public get freeSlotCount(): number {
    let count = 0;
    for (const go of this.spawnedSlots) {
      const slot = go.getComponent(Slot);
      if (slot !== null && !slot.isOccupied) {
        count++;
      }
    }
    return count;
  }

  /** Scene view: where each slot will be and how a car parks in it. */
  onDrawGizmos(): void {
    Handles.label(this.transform.position, "ParkingManager")
    if (!this.drawSlotGizmos) {
      return;
    }
    const root = this.container ?? this.gameObject;
    const slotCount = Math.max(0, Math.floor(this.count));
    const firstX = -((slotCount - 1) * this.spacing) / 2;
    const radians = this.parkedYaw * Math.PI / 180;
    // Car body axes after rotating about +Y by slotYaw (length along local Z).
    const along = new Vector3(Math.sin(radians) * 0.8, 0, Math.cos(radians) * 0.8);
    const across = new Vector3(Math.cos(radians) * 0.47, 0, -Math.sin(radians) * 0.47);
    Gizmos.color = GIZMO_YELLOW;
    for (let index = 0; index < slotCount; index++) {
      // Cocos Vec3.transformMat4(out, local, root.worldMatrix).
      const centre = root.transform.transformPoint(new Vector3(firstX + index * this.spacing, 0.05, 0));
      const corners = [
        centre.add(along).add(across),
        centre.add(along).sub(across),
        centre.sub(along).sub(across),
        centre.sub(along).add(across),
      ];
      Gizmos.drawLineStrip(corners, true);
      Gizmos.drawLine(centre, centre.add(along));
    }
  }

  private clearSlots(root: GameObject): void {
    // `container` is dedicated to generated slots. Removing its editor preview
    // too prevents it from becoming an unintended extra sixth slot at runtime.
    // (Cocos root.destroyAllChildren(): destroyed at the end of the frame.)
    for (const child of root.transform.children) {
      this.destroy(child.gameObject);
    }
    this.spawnedSlots.length = 0;
  }
}
