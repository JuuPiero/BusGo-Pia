import { MonoBehaviour } from '@pia/core';
import { Pacing } from './Pacing';

const GROUP_PHASE = { name: 'Phase Factors' };
const GROUP_CROWD = { name: 'Crowd & Belt' };
const GROUP_RESPONSE = { name: 'Response' };

/**
 * Inspector for Pacing (StandardPacingSettings). Values are pushed to Pacing on
 * load and every frame, so they can be tuned while playing. Without this
 * component Pacing keeps its built-in Unity defaults.
 */
export class PacingConfig extends MonoBehaviour {
    /** Factor when no other phase applies. */
    baseFactor: number = 1;
    /** Vehicles until the first vehicle is sent to a slot. */
    openingFactor: number = 3;
    /** Vehicles once every vehicle has left the board (end of the level). 1 = no speed-up. */
    boardClearedFactor: number = 2.5;

    /** Passengers and queues during the opening feed (before the first vehicle parks). */
    openingCrowdFactor: number = 1;
    /** Cap of the passenger factor in normal play (the board-cleared phase is clamped to this). */
    crowdMaxFactor: number = 1.5;
    /** Belt during the opening feed, so the belt fills up quickly. */
    openingBeltFactor: number = 3;

    /** Seconds to blend the vehicle and passenger factors when a phase changes. 0 = instant. */
    factorResponseSeconds: number = 0.12;
    /** Seconds to blend the belt factor (longer: the whole belt changes speed at once). */
    beltFactorResponseSeconds: number = 0.6;

    protected onLoad(): void {
        this.apply();
    }

    update(): void {
        this.apply();
    }

    private apply(): void {
        Pacing.baseFactor = this.baseFactor;
        Pacing.openingFactor = this.openingFactor;
        Pacing.boardClearedFactor = this.boardClearedFactor;
        Pacing.openingCrowdFactor = this.openingCrowdFactor;
        Pacing.crowdMaxFactor = this.crowdMaxFactor;
        Pacing.openingBeltFactor = this.openingBeltFactor;
        Pacing.factorResponseSeconds = this.factorResponseSeconds;
        Pacing.beltFactorResponseSeconds = this.beltFactorResponseSeconds;
    }
}
