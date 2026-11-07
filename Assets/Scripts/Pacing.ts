import { Time } from "@pia/core";

/**
 * PlayPresentation pacing (StandardPacingSettings + PhasePacingPolicy), without
 * touch-hold and backlog boosts. Vehicles run at `speed`, walking/running
 * passengers at `crowd`, the belt at `belt`, queue feed and steps at `feed`.
 */
export class Pacing {
    static baseFactor = 1;
    static openingFactor = 3;
    static boardClearedFactor = 2.5;
    static factorResponseSeconds = 0.12;
    static openingCrowdFactor = 1;
    static crowdMaxFactor = 1.5;
    static openingBeltFactor = 3;
    static beltFactorResponseSeconds = 0.6;

    /** A vehicle has been sent to a slot (VehicleParkedPresenter runs at the tap). */
    static vehicleParked = false;
    /** Every vehicle has left the board. */
    static boardCleared = false;
    /** Passengers are leaving the queues or the queues are stepping. */
    static feeding = false;

    static speed = 1;
    static crowd = 1;
    static belt = 1;

    private static lastFrame = -1;

    static get feed(): number {
        return Math.max(Pacing.crowd, Pacing.belt);
    }

    static reset(): void {
        Pacing.vehicleParked = false;
        Pacing.boardCleared = false;
        Pacing.feeding = false;
        Pacing.speed = 0;
        Pacing.crowd = 0;
        Pacing.belt = 0;
        Pacing.lastFrame = -1;
        Pacing.advance(0);
    }

    /** Settles the factors once per frame; later calls in the same frame are ignored. */
    static advance(deltaTime: number): void {
        const frame = Time.frameCount;
        if (frame === Pacing.lastFrame) {
            return;
        }
        Pacing.lastFrame = frame;

        let speed = Pacing.baseFactor;
        if (!Pacing.vehicleParked) speed = Math.max(speed, Pacing.openingFactor);
        if (Pacing.boardCleared) speed = Math.max(speed, Pacing.boardClearedFactor);

        const opening = !Pacing.vehicleParked && Pacing.feeding;
        let crowd = Pacing.baseFactor;
        if (opening) crowd = Math.max(crowd, Pacing.openingCrowdFactor);
        if (Pacing.boardCleared) crowd = Math.max(crowd, Math.min(Pacing.boardClearedFactor, Pacing.crowdMaxFactor));

        Pacing.speed = Pacing.settle(Pacing.speed, speed, deltaTime, Pacing.factorResponseSeconds);
        Pacing.crowd = Pacing.settle(Pacing.crowd, crowd, deltaTime, Pacing.factorResponseSeconds);
        // beltPacingShare is 0: the belt only follows its own phase factor (end-of-level speed: BeltManager.endSpeed).
        const belt = opening ? Pacing.openingBeltFactor : 1;
        Pacing.belt = Pacing.settle(Pacing.belt, belt, deltaTime, Pacing.beltFactorResponseSeconds);
    }

    /** PlayPresentation.Settle: exponential blend in log space. */
    private static settle(current: number, target: number, deltaTime: number, response: number): number {
        if (!(current > 0) || !(target > 0) || response <= 0) {
            return target;
        }
        const blend = 1 - Math.exp(-deltaTime / response);
        return Math.exp(Math.log(current) + (Math.log(target) - Math.log(current)) * blend);
    }
}
