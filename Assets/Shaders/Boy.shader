// Port từ Unity URP Shader Graph "Shader Graphs/Boy" (Unlit, Opaque, Cull Back, ZWrite On).
//
// Hiệu ứng: toon tự tính sáng, KHÔNG dùng đèn trong scene. Hướng sáng là vector _Lighting (world space,
// không normalize, giống graph):
//   1. dải sáng/tối: smoothstep(-0.42, 0.83, dot(N, _Lighting)) trộn _ShadowColor -> _Color
//   2. highlight kiểu Phong: phản xạ _Lighting quanh N so với hướng nhìn, độ gắt theo _Smoothness,
//      vùng highlight = màu nền * 3 + 0.1
//   3. viền fresnel pow(1 - N.V, _Power) kéo màu về _ShadowColor
// Giống graph gốc: không cast / nhận bóng (graph Unlit không có pass ShadowCaster), có fog.
// Khác Unity: PiaEngine là right-handed (forward = -Z) nên khi chép _Lighting từ Unity mà z != 0
// thì đổi dấu z.
Shader "Shader Graphs/Boy"
{
    Properties
    {
        _Color ("BaseColor", Color) = (0.9433962, 0.8255098, 0.1557494, 0)
        _ShadowColor ("ShadowColor", Color) = (0.9056604, 0.5817778, 0.1324315, 1)
        _Lighting ("Lighting (xyz)", Vector) = (1, 1, 0, 0)
        _Smoothness ("Smoothness", Range(0.1, 1)) = 0.5
        _Power ("Power", Float) = 2
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

    vec4 frag(vec2 uv)
    {
        float3 N = normalize(vNormal);
        float3 V = sg_viewDir(vWorldPos);
        float3 L = _Lighting.xyz; // not normalized, as in the graph

        // cel band: shadow color -> base color
        float lit = saturate(smoothstep(-0.42, 0.83, dot(N, L)));
        float4 baseCol = lerp(_ShadowColor, _Color, lit);
        float4 brightCol = saturate(baseCol * 3.0 + 0.1);

        // highlight
        float spec = smoothstep(1.41, 2.34, 1.0 - dot(reflect(L, N), V));
        spec = pow(spec, _Smoothness * 10.0) * _Smoothness;
        float4 col = lerp(baseCol, brightCol, spec);

        // fresnel rim toward the shadow color
        float fresnel = pow(1.0 - saturate(dot(N, V)), _Power);
        col = lerp(col, _ShadowColor, fresnel);

        return float4(col.rgb, 1.0);
    }
    ENDGLSL
}
