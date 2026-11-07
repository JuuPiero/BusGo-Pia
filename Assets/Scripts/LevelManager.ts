import { button, Color, field, Gizmos, Handles, JsonAsset, MonoBehaviour, Time } from '@pia/core';
import { LevelData } from './Data/LevelData';
import { VehicleManager } from './Vehicle/VehicleManager';
import { ParkingManager } from './Parking/ParkingManager';
import { Pacing } from './Pacing';
import { BeltManager } from './Belt/BeltManager';
import { PassengerManager } from './Passenger/PassengerManager';

export class LevelManager extends MonoBehaviour {
  // Public fields appear in the Inspector.
  @field([JsonAsset])
  levels: JsonAsset[] = [];

  levelIndex: number = 0;

  currentLevel: LevelData = new LevelData()

  @field(VehicleManager) vehicleManager: VehicleManager | null = null;
  @field(ParkingManager) parkingManager: ParkingManager | null = null;
  @field(PassengerManager) passengerManager: PassengerManager | null = null;

  @field(BeltManager) beltManager: BeltManager | null = null;
  initialize() {
    this.parseData();
    Pacing.reset();
    this.parkingManager?.initialize();
    this.vehicleManager?.initialize(this.currentLevel, this.parkingManager);
    this.passengerManager?.initialize(this.currentLevel);
    // the belt pulls passenger groups from both queues (takeNextPassengerGroup) onto the main path
    this.beltManager?.initialize(this.currentLevel, this.passengerManager, this.vehicleManager, this.parkingManager);
  }

  @button()
  parseData() {
    this.currentLevel = LevelData.Parse(this.levels[this.levelIndex]);
    if (EDITOR) {
      console.log("PLAY LEVEL: " + this.levels[this.levelIndex].name);
    }
  }

  private gizmoLevelAsset: JsonAsset | null = null;
  private gizmoLevel: LevelData | null = null;

  onDrawGizmos() {
    Handles.label(this.transform.position, "LevelManager")
    // Edit mode: preview the selected level's exit rule (VehicleManager draws the live state while playing).
    const asset = this.levels[this.levelIndex] ?? null;
    if (asset === null || this.vehicleManager === null) {
      return;
    }
    if (asset !== this.gizmoLevelAsset) {
      this.gizmoLevelAsset = asset;
      this.gizmoLevel = LevelData.Parse(asset);
    }
    this.vehicleManager.drawLevelExitGizmos(this.gizmoLevel as LevelData);
  }


}
