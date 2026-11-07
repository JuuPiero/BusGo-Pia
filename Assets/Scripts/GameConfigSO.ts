import { GameObject, ScriptableObject, createAssetMenu, field } from '@pia/core';

// Create assets of this type from Project → Create → Scriptable Objects → GameConfiSO.
@createAssetMenu({ fileName: 'GameConfiSO', menuName: 'Configs/GameConfiSO' })
export class GameConfiSO extends ScriptableObject {
  // Public fields appear in the Inspector and are saved in the .asset.json file.
  @field(GameObject)
  busPrefab: GameObject | null = null;
 
  @field(GameObject) carPrefab: GameObject | null = null;
  @field(GameObject) vanPrefab: GameObject | null = null;
  @field(GameObject) slotPrefab: GameObject | null = null;
  /** A single character. PassengerManager creates the queue from this prefab. */
  @field(GameObject) passengerPrefab: GameObject | null = null;
}
