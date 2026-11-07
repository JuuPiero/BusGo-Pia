import { button, Debug, field, Handles, MonoBehaviour, Time } from '@pia/core';
import { EventBus } from './EventBus';
import { GameEvents } from './GameEvents';
import { LevelManager } from './LevelManager';
import { GameConfiSO } from './GameConfigSO';
import { ServiceLocator } from './ServiceLocator';
import { ColorConfigSO } from './Data/ColorConfigSO';
import { ETrackingEvent, TrackingManager } from './TrackingManager';

export class GameManager extends MonoBehaviour {
  @field(GameConfiSO) gameConfig: GameConfiSO | null = null;
  @field(ColorConfigSO) colorConfig: ColorConfigSO | null = null;

  @field(LevelManager)
  levelManager: LevelManager | null = null;

  onEnable(): void {
    EventBus.on(GameEvents.NEW_GAME, this.onNewGame)
    EventBus.on(GameEvents.WIN_GAME, this.onWinGame)
    EventBus.on(GameEvents.LOSE_GAME, this.onLoseGame)
    EventBus.on(GameEvents.VEHICLE_DEPARTED, this.onProgress)

  }

  onDisable(): void {
    EventBus.off(GameEvents.NEW_GAME, this.onNewGame)
    EventBus.off(GameEvents.WIN_GAME, this.onWinGame)
    EventBus.off(GameEvents.LOSE_GAME, this.onLoseGame)
    EventBus.off(GameEvents.VEHICLE_DEPARTED, this.onProgress)

  }
  awake(): void {
    ServiceLocator.register(GameManager, this);
    ServiceLocator.register(GameConfiSO, this.gameConfig);
    ServiceLocator.register(ColorConfigSO, this.colorConfig);
  }

  start(): void {
    TrackingManager.TrackEvent(ETrackingEvent.LOADING);
    EventBus.emit(GameEvents.NEW_GAME);
    TrackingManager.TrackEvent(ETrackingEvent.LOADED);
    TrackingManager.TrackEvent(ETrackingEvent.DISPLAYED);
  }
  onNewGame = () => {
    this.levelManager?.initialize();
  }

  progress: number = 0
  total: number = 0
  progressTracked = {
    quarter: false,  // 25%
    half: false,     // 50%
    threeQuarter: false  // 75%
  }
  onProgress = () => {

    this.progress++
    const percentage = (this.progress / this.total) * 100

    if (EDITOR) {
      console.log("progress " + percentage)
    }
    if (!this.progressTracked.quarter && percentage >= 25) {
      this.progressTracked.quarter = true
      TrackingManager.TrackEvent(ETrackingEvent.CHALLENGE_PASS_25)
    }

    if (!this.progressTracked.half && percentage >= 50) {
      this.progressTracked.half = true
      TrackingManager.TrackEvent(ETrackingEvent.CHALLENGE_PASS_50)
    }

    if (!this.progressTracked.threeQuarter && percentage >= 75) {
      this.progressTracked.threeQuarter = true
      TrackingManager.TrackEvent(ETrackingEvent.CHALLENGE_PASS_75)
    }
    if (this.progress === this.total) {
      TrackingManager.TrackEvent(ETrackingEvent.CHALLENGE_SOLVED)
    }
  }

  onDrawGizmos() {
    Handles.label(this.transform.position, "GameManager")
  }

  onLoseGame = () => {

  }

  onWinGame = () => {

  }
}
