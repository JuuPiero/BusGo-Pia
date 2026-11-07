import { Color, field, Gizmos, MonoBehaviour, Vector3 } from '@pia/core';

/** Cocos Color.GREEN (PiaEngine colours are 0..1). */
const GIZMO_GREEN = new Color(0, 1, 0, 1);

/**
 * Belt exit gate as a box (SceneLayout.ExitGateStartT..EndT, authored in the scene).
 * A belt row may leave for a vehicle while its centre is inside the box, or when
 * its last drift crossed it. The box lives in the GameObject's local space, so moving,
 * rotating or scaling it moves the box; its position is also the pickup
 * point the boarding mouth is measured from. Height (local Y) is ignored.
 */
export class ExitGate extends MonoBehaviour {
    /** Box size in the GameObject's local space (X across, Z along the belt). */
    @field(Vector3) size: Vector3 = new Vector3(2, 1, 1);

    /** The world point lies inside the box (XZ only). */
    containsPoint(world: Readonly<Vector3>): boolean {
        const local = this.toLocal(world);
        return Math.abs(local.x) <= this.size.x / 2 && Math.abs(local.z) <= this.size.z / 2;
    }

    /** The world segment from -> to touches the box (XZ only): a row that crossed it within one frame. */
    intersectsSegment(from: Readonly<Vector3>, to: Readonly<Vector3>): boolean {
        const a = this.toLocal(from);
        const b = this.toLocal(to);
        let enter = 0;
        let leave = 1;
        for (const axis of ['x', 'z'] as const) {
            const half = this.size[axis] / 2;
            const delta = b[axis] - a[axis];
            if (Math.abs(delta) < 1e-6) {
                if (Math.abs(a[axis]) > half) {
                    return false;
                }
                continue;
            }
            const t0 = (-half - a[axis]) / delta;
            const t1 = (half - a[axis]) / delta;
            enter = Math.max(enter, Math.min(t0, t1));
            leave = Math.min(leave, Math.max(t0, t1));
            if (enter > leave) {
                return false;
            }
        }
        return true;
    }

    /**
     * Cocos: Vec3.transformMat4(world, invert(node.worldMatrix)). worldToLocalMatrix is that
     * inverse (incl. scale) and transformPoint divides by w like transformMat4.
     */
    private toLocal(world: Readonly<Vector3>): Vector3 {
        return this.transform.worldToLocalMatrix.transformPoint(world as Vector3);
    }

    onDrawGizmos(): void {
        Gizmos.color = GIZMO_GREEN;
        Gizmos.matrix = this.transform.localToWorldMatrix; // Cocos node.worldMatrix (local -> world)
        Gizmos.drawWireCube(Vector3.zero, this.size);
    }
}
