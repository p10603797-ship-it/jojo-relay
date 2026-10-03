import * as THREE from 'three';
import { SUN_DIR, SKY_COLORS } from './sky.js';

/** Stylised ocean: scrolling normals, depth-based colour from the terrain texture, shore foam. */
export function createWater(normalTex, terrainTex, half, cell, n) {
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    uTime: { value: 0 },
    uNormal: { value: null },
    uTerrain: { value: null },
    uHalf: { value: half },
    uCell: { value: cell },
    uN: { value: n },
    uSun: { value: SUN_DIR },
    uDeep: { value: new THREE.Color(0x0a5a8c) },
    uShallow: { value: new THREE.Color(0x36d0c4) },
    uSky: { value: SKY_COLORS.horizon },
  }]);
  uniforms.uNormal.value = normalTex;
  uniforms.uTerrain.value = terrainTex;
  const mat = new THREE.ShaderMaterial({
    uniforms,
    fog: true,
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */`
      #include <fog_pars_vertex>
      varying vec3 vW;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        vec4 mvPosition = viewMatrix * w;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */`
      #include <common>
      #include <fog_pars_fragment>
      uniform float uTime, uHalf, uCell, uN;
      uniform sampler2D uNormal, uTerrain;
      uniform vec3 uSun, uDeep, uShallow, uSky;
      varying vec3 vW;
      void main() {
        vec2 uv1 = vW.xz * 0.045 + vec2(uTime * 0.012, uTime * 0.008);
        vec2 uv2 = vW.xz * 0.093 + vec2(-uTime * 0.011, uTime * 0.015);
        vec3 n1 = texture2D(uNormal, uv1).xyz * 2.0 - 1.0;
        vec3 n2 = texture2D(uNormal, uv2).xyz * 2.0 - 1.0;
        vec3 n = normalize(vec3(n1.x + n2.x, 5.0, n1.y + n2.y));
        vec3 V = normalize(cameraPosition - vW);
        vec2 tuv = ((vW.xz + uHalf) / uCell + 0.5) / uN;
        float th = -20.0;
        if (tuv.x > 0.0 && tuv.x < 1.0 && tuv.y > 0.0 && tuv.y < 1.0) th = texture2D(uTerrain, tuv).r;
        float depth = max(0.0, -th);
        float shallow = exp(-depth * 0.2);
        vec3 base = mix(uDeep, uShallow, shallow);
        float fres = pow(1.0 - max(dot(V, n), 0.0), 5.0) * 0.8 + 0.03;
        vec3 col = mix(base, uSky, fres);
        vec3 R = reflect(-uSun, n);
        col += vec3(1.0, 0.94, 0.8) * pow(max(dot(R, V), 0.0), 160.0) * 2.5;
        float fn = texture2D(uNormal, vW.xz * 0.21 + vec2(uTime * 0.02, 0.0)).b;
        float foam = smoothstep(1.1, 0.0, depth) * smoothstep(0.42, 0.7, fn + 0.25 * sin(depth * 11.0 - uTime * 2.2));
        col = mix(col, vec3(0.96), foam * 0.85);
        float alpha = mix(0.95, 0.5, shallow * smoothstep(1.8, 0.0, depth));
        gl_FragColor = vec4(col, max(alpha, foam));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  const geo = new THREE.PlaneGeometry(4000, 4000, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'water';
  mesh.renderOrder = 1;
  return mesh;
}
