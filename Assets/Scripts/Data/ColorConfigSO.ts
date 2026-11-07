import { Color, createAssetMenu, field, MonoBehaviour, ScriptableObject, Time } from '@pia/core';

@createAssetMenu({ fileName: 'ColorConfigSO', menuName: 'Configs/ColorConfigSO' })
export class ColorConfigSO extends ScriptableObject {
  @field([Color]) colors: Color[] = [];
  @field([Color]) shadowColors: Color[] = [];
  @field({ type: Color }) hidden: Color = new Color()
  @field({ type: Color }) hiddenShadow: Color = new Color()
}
