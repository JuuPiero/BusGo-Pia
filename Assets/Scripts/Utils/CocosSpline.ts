import { Quaternion, Vector3 } from '@pia/core';
import { SplineContainer } from 'com.pia.spline';
import { quatFromViewUp } from './CocosMath';

// ---------- Cocos SplineContainer (db://splines) calls on com.pia.spline ----------
// Both libraries take t normalized by length (Unity semantics) and return world space.

/** SplineContainer.calculateLength(). */
export function pathLength(path: SplineContainer): number {
    return path.getLength();
}

/** SplineContainer.evaluateDirection(t): world unit direction of travel. */
export function pathDirection(path: SplineContainer, t: number): Vector3 {
    return path.evaluateTangent(t).normalize();
}

/** SplineContainer.evaluateRotation(t): Quat.fromViewUp(direction, up), +Z along the path. */
export function pathRotation(path: SplineContainer, t: number): Quaternion {
    return quatFromViewUp(pathDirection(path, t), path.evaluateUpVector(t));
}
