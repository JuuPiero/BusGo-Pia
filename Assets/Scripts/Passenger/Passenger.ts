import { Color, Debug, field, Material, MeshRenderer, MonoBehaviour, SkinnedMeshRenderer } from '@pia/core';
import { ServiceLocator } from '../ServiceLocator';
import { ColorConfigSO } from '../Data/ColorConfigSO';

export class Passenger extends MonoBehaviour {
  @field(SkinnedMeshRenderer) renderer: SkinnedMeshRenderer | null = null;

  /** Original color index in level JSON. Kept for the later belt/boarding step. */
  public colorIndex: number = 0;

  initialize(colorIndex: number, queueSide: 'Left' | 'Right' = 'Left', queuePosition: number = 0): void {
    this.colorIndex = colorIndex;
    this.gameObject.name = `Passenger_${queueSide}_${queuePosition + 1}`;

    if (this.renderer === null) {
      Debug.error(`[Passenger] ${this.gameObject.name} is missing its MeshRenderer reference.`);
      return;
    }

    const colorConfig = ServiceLocator.get(ColorConfigSO);
    const color = colorConfig.colors[colorIndex];
    const shadowColor = colorConfig.shadowColors[colorIndex];
    if (color === undefined || shadowColor === undefined) {
      console.error(`[Passenger] Color index ${colorIndex} is not configured in ColorConfig.`);
      return;
    }

    if (this.renderer && color && shadowColor) {
      const mat = Passenger.colorMaterial(this.renderer, colorIndex, color, shadowColor);
      if (mat) this.renderer.sharedMaterial = mat;
    }
    // Keep the shared Boy.mtl (GPU instancing on) instead of cloning a material
    // per passenger, so every passenger still batches into one draw call.
    // Per-passenger color rides the a_instancedColor/a_instancedShadowColor
    // vertex attributes (see Boy.effect) rather than a per-instance uniform.
    // this.renderer.setInstancedAttribute('a_instancedColor', Passenger.toInstancedColor(color));
    // this.renderer.setInstancedAttribute('a_instancedShadowColor', Passenger.toInstancedColor(shadowColor));
  }

  private static readonly colorMaterials = new Map<Material, Map<number, Material>>();

  private static colorMaterial(renderer: SkinnedMeshRenderer, index: number, color: Color, shadowColor: Color): Material | null {
    // the material the prefab was set up with (an already-coloured copy maps back to its source)
    let source = renderer.sharedMaterial;
    if (!source || !source.shader) return null;
    for (const [src, byColor] of Passenger.colorMaterials) {
      for (const m of byColor.values()) if (m === source) source = src;
    }
    let byColor = Passenger.colorMaterials.get(source);
    if (!byColor) Passenger.colorMaterials.set(source, (byColor = new Map()));
    let mat = byColor.get(index);
    if (!mat) {
      mat = Material.create(source.shader!);
      mat.copyPropertiesFromMaterial(source);
      mat.enableInstancing = source.enableInstancing;
      mat.name = `${source.name} (color ${index})`;
      mat.setColor('_Color', color);
      mat.setColor('_ShadowColor', shadowColor);
      byColor.set(index, mat);
    }
    return mat;
  }

}
