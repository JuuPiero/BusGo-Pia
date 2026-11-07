import { Quaternion, Vector3 } from '@pia/core';

// ---------- Cocos Vec3 / Quat static helpers ----------
//
// Ports from Cocos Creator used Vec3's static out-parameter API (Vec3.add(out, a, b), ...),
// whose results are written into `out` (which may alias an input). PiaEngine's Vector3
// methods return new vectors instead, so these mirror the Cocos 3.x functions exactly to
// keep ported code call-for-call identical. Vec3.lerp does NOT clamp t (Vector3.lerp does).
export const V3 = {
    add(out: Vector3, a: Readonly<Vector3>, b: Readonly<Vector3>): Vector3 {
        return out.set(a.x + b.x, a.y + b.y, a.z + b.z);
    },
    subtract(out: Vector3, a: Readonly<Vector3>, b: Readonly<Vector3>): Vector3 {
        return out.set(a.x - b.x, a.y - b.y, a.z - b.z);
    },
    multiplyScalar(out: Vector3, a: Readonly<Vector3>, s: number): Vector3 {
        return out.set(a.x * s, a.y * s, a.z * s);
    },
    /** out = a + b * s */
    scaleAndAdd(out: Vector3, a: Readonly<Vector3>, b: Readonly<Vector3>, s: number): Vector3 {
        return out.set(a.x + b.x * s, a.y + b.y * s, a.z + b.z * s);
    },
    dot(a: Readonly<Vector3>, b: Readonly<Vector3>): number {
        return a.x * b.x + a.y * b.y + a.z * b.z;
    },
    distance(a: Readonly<Vector3>, b: Readonly<Vector3>): number {
        const x = b.x - a.x;
        const y = b.y - a.y;
        const z = b.z - a.z;
        return Math.sqrt(x * x + y * y + z * z);
    },
    lerp(out: Vector3, a: Readonly<Vector3>, b: Readonly<Vector3>, t: number): Vector3 {
        return out.set(a.x + t * (b.x - a.x), a.y + t * (b.y - a.y), a.z + t * (b.z - a.z));
    },
    cross(out: Vector3, a: Readonly<Vector3>, b: Readonly<Vector3>): Vector3 {
        return out.set(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
    },
    /** Vec3.transformQuat(out, a, q): `a` rotated by `q`. */
    transformQuat(out: Vector3, a: Readonly<Vector3>, q: Readonly<Quaternion>): Vector3 {
        // Same formula as Cocos (q * a * q^-1, expanded).
        const ix = q.w * a.x + q.y * a.z - q.z * a.y;
        const iy = q.w * a.y + q.z * a.x - q.x * a.z;
        const iz = q.w * a.z + q.x * a.y - q.y * a.x;
        const iw = -q.x * a.x - q.y * a.y - q.z * a.z;
        return out.set(
            ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
            iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
            iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
        );
    },
    squaredDistance(a: Readonly<Vector3>, b: Readonly<Vector3>): number {
        const x = b.x - a.x;
        const y = b.y - a.y;
        const z = b.z - a.z;
        return x * x + y * y + z * z;
    },
    /** Vec3.normalize(out, a): any non-zero length is normalized (Vector3.normalize zeroes below 1e-5). */
    normalize(out: Vector3, a: Readonly<Vector3>): Vector3 {
        let len = a.x * a.x + a.y * a.y + a.z * a.z;
        if (len > 0) {
            len = 1 / Math.sqrt(len);
            return out.set(a.x * len, a.y * len, a.z * len);
        }
        return out.set(a.x, a.y, a.z);
    },
};

/** Cocos Quat.slerp(out, a, b, t): t is not clamped, the result is not normalized. */
export function quatSlerp(a: Readonly<Quaternion>, b: Readonly<Quaternion>, t: number): Quaternion {
    let bx = b.x;
    let by = b.y;
    let bz = b.z;
    let bw = b.w;
    let cosom = a.x * bx + a.y * by + a.z * bz + a.w * bw;
    if (cosom < 0.0) {
        cosom = -cosom;
        bx = -bx;
        by = -by;
        bz = -bz;
        bw = -bw;
    }
    let scale0: number;
    let scale1: number;
    if ((1.0 - cosom) > 0.000001) {
        const omega = Math.acos(cosom);
        const sinom = Math.sin(omega);
        scale0 = Math.sin((1.0 - t) * omega) / sinom;
        scale1 = Math.sin(t * omega) / sinom;
    } else {
        scale0 = 1.0 - t;
        scale1 = t;
    }
    return new Quaternion(
        scale0 * a.x + scale1 * bx,
        scale0 * a.y + scale1 * by,
        scale0 * a.z + scale1 * bz,
        scale0 * a.w + scale1 * bw,
    );
}

/** Cocos Quat.fromAxisAngle(out, axis, radians): the axis is used as given (not normalized). */
export function quatFromAxisAngle(axis: Readonly<Vector3>, radians: number): Quaternion {
    const half = radians * 0.5;
    const s = Math.sin(half);
    return new Quaternion(s * axis.x, s * axis.y, s * axis.z, Math.cos(half));
}

/**
 * Cocos Quat.fromViewUp(out, view, up) (Mat3.fromViewUp + Quat.fromMat3): +Z along `view`
 * (expected normalized), +Y toward `up`. Degenerate input gives the identity, like Cocos.
 */
export function quatFromViewUp(view: Readonly<Vector3>, up: Readonly<Vector3> = Vector3.up): Quaternion {
    const EPSILON = 0.000001;
    if (view.x * view.x + view.y * view.y + view.z * view.z < EPSILON * EPSILON) {
        return Quaternion.identity;
    }
    const x = V3.cross(new Vector3(), up, view);
    const lx = x.x * x.x + x.y * x.y + x.z * x.z;
    if (lx > 0) V3.multiplyScalar(x, x, 1 / Math.sqrt(lx));
    if (x.x * x.x + x.y * x.y + x.z * x.z < EPSILON * EPSILON) {
        return Quaternion.identity;
    }
    const y = V3.cross(new Vector3(), view, x);
    return Quaternion.fromBasis(x, y, new Vector3(view.x, view.y, view.z));
}
