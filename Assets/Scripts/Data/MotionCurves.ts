/** One Unity AnimationCurve key (weightedMode 0). */
interface CurveKey {
    time: number;
    value: number;
    inSlope: number;
    outSlope: number;
}

/** Unity AnimationCurve.Evaluate for unweighted keys: cubic Hermite per segment, clamped outside the keys. */
export class MotionCurve {
    constructor(private readonly keys: readonly CurveKey[]) {}

    evaluate(time: number): number {
        const keys = this.keys;
        if (time <= keys[0].time) {
            return keys[0].value;
        }
        const last = keys[keys.length - 1];
        if (time >= last.time) {
            return last.value;
        }
        let i = 0;
        while (i < keys.length - 2 && keys[i + 1].time < time) {
            i++;
        }
        const a = keys[i];
        const b = keys[i + 1];
        const dt = b.time - a.time;
        const s = (time - a.time) / dt;
        const s2 = s * s;
        const s3 = s2 * s;
        const h00 = 2 * s3 - 3 * s2 + 1;
        const h10 = s3 - 2 * s2 + s;
        const h01 = -2 * s3 + 3 * s2;
        const h11 = s3 - s2;
        return h00 * a.value + h10 * dt * a.outSlope + h01 * b.value + h11 * dt * b.inSlope;
    }
}

/** Curves from StandardMotionTuning.asset. */
export const MotionCurves = {
    /** punchShape: shared by pops, arrive bounce, impact punch and blocker shove. */
    punchShape: new MotionCurve([
        { time: 0, value: 0, inSlope: 0, outSlope: 6 },
        { time: 0.3, value: 1, inSlope: 0, outSlope: 0 },
        { time: 1, value: 0, inSlope: 0, outSlope: 0 },
    ]),
    /** bounceBackCurve: rebound and drift back after a blocked lunge. */
    bounceBack: new MotionCurve([
        { time: 0, value: 0, inSlope: 2, outSlope: 2 },
        { time: 1, value: 1, inSlope: 0, outSlope: 0 },
    ]),
    /** queueStepCurve (linear). */
    queueStep: new MotionCurve([
        { time: 0, value: 0, inSlope: 1, outSlope: 1 },
        { time: 1, value: 1, inSlope: 1, outSlope: 1 },
    ]),
    /** streamEntryScaleCurve: figure size while it enters the vehicle body. */
    streamEntryScale: new MotionCurve([
        { time: 0, value: 1, inSlope: 0, outSlope: 0 },
        { time: 1, value: 0.8, inSlope: 0, outSlope: 0 },
    ]),
};

/** Mathf.SmoothStep(0, 1, t). */
export function smoothStep01(t: number): number {
    const x = Math.max(0, Math.min(1, t));
    return x * x * (3 - 2 * x);
}
