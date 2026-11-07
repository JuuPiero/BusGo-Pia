// Port từ Unity URP Shader Graph "Shader Graphs/Car" (Unlit, Opaque, Cull Back, ZWrite On).
//
// Hiệu ứng: cùng kiểu toon tự tính sáng như Boy (không dùng đèn trong scene, hướng sáng = _Lighting),
// cộng thêm 2 texture mask theo UV0:
//   - _Texture_Main: kênh R (smoothstep 0.2..0.5) là vùng tối / AO vẽ sẵn (R thấp -> _ShadowColor);
//     RGB của nó còn được hiện thẳng ở những chỗ _Texture_Support.R = 1.
//   - _Texture_Support: R = hiện màu _Texture_Main, G = vùng gần đen (kính, lốp: pow(màu * 0.1, 1.2)),
//     B = vùng sáng hơn (+0.15: đèn, viền).
//   - viền fresnel pow(1 - N.V, _Power) kéo về _ShadowColor.
// _Hidden = 1 (xe "ẩn"): bỏ mask Support + fresnel, phủ một hoạ tiết lặp 6x6 theo UV, trôi chéo chậm
// (UV * 6 + thời gian * 0.03), chỗ hoạ tiết có alpha thì sáng thêm 0.2.
//
// Xấp xỉ / khác Unity:
//   - Texture hoạ tiết của chế độ Hidden được nhúng cứng trong graph (_Texture2DAsset_fac2a0b8..., không
//     phải thuộc tính của material) nên không biết là ảnh nào: ở đây là _PatternTex (dùng kênh A).
//     Khi _ProceduralPattern = 1 (mặc định) shader tự vẽ sọc chéo thay cho ảnh; gán ảnh gốc vào
//     _PatternTex rồi tắt _ProceduralPattern để giống hệt Unity. Ảnh tự lặp, không cần Wrap Mode Repeat.
//   - Mặc định của _Texture_Support là "black" (không mask nào) thay vì "white" như graph: để trống thì
//     xe vẫn ra màu toon thay vì trắng toàn bộ. Material đã gán ảnh thì như Unity.
//   - Unity có thể import _Texture_Support dạng linear (bỏ sRGB). Nếu vậy, trong Import Settings của
//     ảnh đó bỏ tick sRGB cho khớp.
//   - Không cast / nhận bóng (graph Unlit không có pass ShadowCaster), có fog.
//   - PiaEngine là right-handed (forward = -Z): chép _Lighting từ Unity mà z != 0 thì đổi dấu z.
Shader "Shader Graphs/Car"
{
    Properties
    {
        _Color ("BaseColor", Color) = (0.9433962, 0.8255098, 0.1557494, 0)
        _ShadowColor ("ShadowColor", Color) = (0.9056604, 0.5817778, 0.1324315, 1)
        _Lighting ("Lighting (xyz)", Vector) = (1, 1, 0, 0)
        _Smoothness ("Smoothness", Range(0.1, 1)) = 0.5
        _Power ("Power", Float) = 2
        [NoScaleOffset] _Texture_Main ("Texture Main", 2D) = "white" {}
        [NoScaleOffset] _Texture_Support ("Texture Support", 2D) = "black" {}
        [Toggle] _Hidden ("Hidden", Float) = 0
        [Header(Hidden Pattern)]
        [NoScaleOffset] _PatternTex ("Pattern (A)", 2D) = "clear" {}
        [Toggle] _ProceduralPattern ("Procedural Pattern", Float) = 1
    }
    Pipeline 3D
    Lighting Unlit
    Queue Geometry
    Blend Opaque
    Cull Back
    ZWrite On
    ZTest LEqual

    GLSLPROGRAM
    // normalized world-space direction from the surface to the camera (also right for ortho cameras)
    float3 sg_viewDir(float3 worldPos)
    {
        if (isOrthographic) return normalize(float3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]));
        return normalize(_WorldSpaceCameraPos - worldPos);
    }

    // alpha of the Hidden overlay at the tiled UV (the graph samples an embedded texture here)
    float sg_pattern(float2 p)
    {
        if (_ProceduralPattern > 0.5)
        {
            // anti-aliased diagonal stripes, 3 per tile (vehicle UVs only span ~2 tiles)
            float w = (p.x + p.y) * 1.5;
            float f = abs(fract(w) - 0.5);
            float aa = fwidth(w);
            return 1.0 - smoothstep(0.25 - aa, 0.25 + aa, f);
        }
        // the texture repeats whatever its Wrap Mode (gradients of the unwrapped UV: no seams)
        return textureGrad(_PatternTex, fract(p), dFdx(p), dFdy(p)).a;
    }

    vec4 frag(vec2 uv)
    {
        float3 N = normalize(vNormal);
        float3 V = sg_viewDir(vWorldPos);
        float3 L = _Lighting.xyz; // not normalized, as in the graph

        // cel band + highlight (Car uses softer numbers than Boy)
        float lit = saturate(smoothstep(-0.42, 0.83, dot(N, L)));
        float4 baseCol = lerp(_ShadowColor, _Color, lit);
        float4 brightCol = saturate(baseCol * 1.8 + 0.001);
        float spec = smoothstep(1.25, 2.46, 1.0 - dot(reflect(L, N), V));
        spec = pow(spec, _Smoothness * 5.41) * _Smoothness;
        float4 toon = lerp(baseCol, brightCol, spec);

        // _Texture_Main.R: painted shadow / AO
        float4 mainCol = tex2D(_Texture_Main, uv);
        float4 col = lerp(_ShadowColor, toon, smoothstep(0.2, 0.5, mainCol.r));

        if (_Hidden > 0.5)
        {
            float pattern = sg_pattern(uv * 6.0 + _Time.y * 0.03);
            return float4(lerp(col, col + 0.2, pattern).rgb, 1.0);
        }

        // _Texture_Support: G = near black, B = brighter, R = show _Texture_Main as is
        float4 support = tex2D(_Texture_Support, uv);
        float4 c = lerp(col, pow(max(col, 0.0) * 0.1, float4(1.2)), support.g);
        c = lerp(c, c + 0.15, support.b);
        c = lerp(c, mainCol, support.r);

        // fresnel rim toward the shadow color
        float fresnel = pow(1.0 - saturate(dot(N, V)), _Power);
        c = lerp(c, _ShadowColor, fresnel);

        return float4(c.rgb, 1.0);
    }
    ENDGLSL
}
