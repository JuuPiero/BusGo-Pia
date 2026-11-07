import { Color, field, GameObject, isAlive, MonoBehaviour, Text, TextRenderer, Time } from '@pia/core';
import { Pacing } from '../Pacing';

export class Slot extends MonoBehaviour {
    /** Zero-based index from left to right in the parking row (runtime only, like Cocos: not a @property). */
    @field({ nonSerialized: true }) public index: number = -1;
    private _occupant: GameObject | null = null;

    /** SlotView count label: figures the parked vehicle still waits for. */
    @field(TextRenderer) countLabel: TextRenderer | null = null;

    // Runtime state. Private number fields start with `_`: PiaEngine would otherwise
    // serialize (and show) them like any field with a plain default.
    /** Count currently shown, or -1 while hidden. */
    private _shownCount = -1;
    private _countAlpha = 1;
    private _countFadeDuration = 0;
    private _baseColor: Color | null = null;

    get isOccupied(): boolean {
        return this._occupant !== null && isAlive(this._occupant);
    }

    /** True only for the GameObject which currently owns this reservation. */
    isClaimedBy(vehicle: GameObject): boolean {
        return this._occupant === vehicle;
    }

    initialize(index: number): void {
        this.index = index;
        this._occupant = null;
        this.gameObject.name = `Slot_${index + 1}`;
        this.hideCount();
    }

    /** Reserve before the tween begins, so two quick clicks cannot choose one slot. */
    tryClaim(vehicle: GameObject): boolean {
        if (this.isOccupied) {
            return false;
        }

        this._occupant = vehicle;
        return true;
    }

    /** A stale or unrelated vehicle must never be able to release this slot. */
    release(vehicle: GameObject): boolean {
        if (this._occupant !== vehicle) {
            return false;
        }
        this._occupant = null;
        return true;
    }

    /**
     * SlotView.ShowCount: show `remaining`. A hidden label fades in over
     * `fadeInDuration` seconds (MotionTuning.countFadeInDuration); a shown one only
     * changes its number.
     */
    showCount(remaining: number, fadeInDuration: number): void {
        if (this.countLabel === null) {
            return;
        }
        if (this._baseColor === null) {
            this._baseColor = this.countLabel.color.clone();
        }
        if (this._shownCount < 0) {
            this._countAlpha = fadeInDuration > 0 ? 0 : 1;
            this._countFadeDuration = fadeInDuration;
        }
        this.countLabel.gameObject.setActive(true);
        if (this._shownCount !== remaining) {
            this.countLabel.text = `${remaining}`;
        }
        this._shownCount = remaining;
        this.applyAlpha();
    }

    /** SlotView.HideCount. */
    hideCount(): void {
        this._shownCount = -1;
        if (this.countLabel !== null) {
            if (this._baseColor === null) {
                this._baseColor = this.countLabel.color.clone();
            }
            this.countLabel.gameObject.setActive(false);
        }
    }

    update(): void {
        // SlotView.AdvanceCountFade, on the vehicle clock.
        if (this._shownCount < 0 || this._countAlpha >= 1) {
            return;
        }
        const seconds = Time.deltaTime * Pacing.speed;
        this._countAlpha = this._countFadeDuration > 0 ? Math.min(1, this._countAlpha + seconds / this._countFadeDuration) : 1;
        this.applyAlpha();
    }

    private applyAlpha(): void {
        if (this.countLabel === null || this._baseColor === null) {
            return;
        }
        const color = this._baseColor.clone();
        // Cocos alpha is 0..255 (hence its Math.round); PiaEngine's is 0..1.
        color.a = this._baseColor.a * this._countAlpha;
        this.countLabel.color = color;
    }
}
