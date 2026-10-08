import * as THREE from 'three';
import { SUN_DIR, SKY_COLORS } from './sky.js';

const SWAMP = 10; // BIOMES index of the swamp (shared/world/keys.js), stored in the info texture's alpha

/**
 * Stylised water: scrolling normals, depth colour from the terrain info texture (R height,
 * A biome), shore foam, murky green in the swamp. The mesh is a disc that follows the camera
 * with a radius of camera.far x 0.95, so its edge is always deep in the fog and never cut by the
 * far plane. setSeaLevel(y, 'water' | 'lava') raises it (Floor is Lava) and turns it to lava.
 */
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
    uSwamp: { value: new THREE.Color(0x4f6a2e) },
    uSky: { value: SKY_COLORS.horizon },
    uLava: { value: 0 },
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
      uniform float uTime, uHalf, uCell, uN, uLava;
      uniform sampler2D uNormal, uTerrain;
      uniform vec3 uSun, uDeep, uShallow, uSky, uSwamp;
      varying vec3 vW;
      void main() {
        vec2 uv1 = vW.xz * 0.045 + vec2(uTime * 0.012, uTime * 0.008);
        vec2 uv2 = vW.xz * 0.093 + vec2(-uTime * 0.011, uTime * 0.015);
        vec3 n1 = texture2D(uNormal, uv1).xyz * 2.0 - 1.0;
        vec3 n2 = texture2D(uNormal, uv2).xyz * 2.0 - 1.0;
        vec3 n = normalize(vec3(n1.x + n2.x, 5.0, n1.y + n2.y));
        vec3 V = normalize(cameraPosition - vW);
        vec2 tuv = ((vW.xz + uHalf) / uCell + 0.5) / uN;
        float th = -16.0, biome = 0.0;
        if (tuv.x > 0.0 && tuv.x < 1.0 && tuv.y > 0.0 && tuv.y < 1.0) { vec4 ti = texture2D(uTerrain, tuv); th = ti.r; biome = ti.a; }
        float depth = max(0.0, vW.y - th);
        float shallow = exp(-depth * 0.2);
        vec3 base = mix(uDeep, uShallow, shallow);
        float swamp = 1.0 - smoothstep(0.3, 0.7, abs(biome - ${SWAMP.toFixed(1)}));
        base = mix(base, uSwamp * (0.7 + 0.3 * shallow), swamp * 0.85);
        float fres = pow(1.0 - max(dot(V, n), 0.0), 5.0) * 0.8 + 0.03;
        vec3 col = mix(base, uSky, fres * (1.0 - swamp * 0.6));
        vec3 R = reflect(-uSun, n);
        col += vec3(1.0, 0.94, 0.8) * pow(max(dot(R, V), 0.0), 160.0) * 2.5;
        float fn = texture2D(uNormal, vW.xz * 0.21 + vec2(uTime * 0.02, 0.0)).b;
        float foam = smoothstep(1.1, 0.0, depth) * smoothstep(0.42, 0.7, fn + 0.25 * sin(depth * 11.0 - uTime * 2.2)) * (1.0 - swamp);
        col = mix(col, vec3(0.96), foam * 0.85);
        // deep water is opaque (nothing below it shows through, wherever the sea floor ends)
        float alpha = mix(mix(0.95, 1.0, smoothstep(3.0, 8.0, depth)), 0.5, shallow * smoothstep(1.8, 0.0, depth));
        alpha = mix(alpha, 0.97, swamp);
        if (uLava > 0.5) {
          // Floor is Lava: glowing, slowly churning
          float g = texture2D(uNormal, vW.xz * 0.03 + vec2(uTime * 0.01, -uTime * 0.007)).b;
          float g2 = texture2D(uNormal, vW.xz * 0.11 - vec2(uTime * 0.02, 0.0)).g;
          col = mix(vec3(0.55, 0.06, 0.01), vec3(1.6, 0.62, 0.08), smoothstep(0.35, 0.8, g * 0.7 + g2 * 0.5));
          col += vec3(1.2, 0.5, 0.1) * (0.4 + 0.3 * sin(uTime * 2.0 + vW.x * 0.05));
          alpha = 1.0;
          foam = 0.0;
        }
        gl_FragColor = vec4(col, max(alpha, foam));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  // a disc of unit radius (scaled to the view distance), denser near the centre
  const geo = new THREE.CircleGeometry(1, 64, 0, Math.PI * 2);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'water';
  mesh.renderOrder = 1;
  mesh.frustumCulled = false;
  mesh.scale.setScalar(2000);
  mesh.userData.level = 0;
  mesh.userData.kind = 'water';
  /** Follow the camera; radius = the camera's far plane x 0.95. */
  mesh.userData.follow = (camera) => {
    mesh.position.set(camera.position.x, mesh.userData.level, camera.position.z);
    const r = camera.far * 0.95;
    if (Math.abs(mesh.scale.x - r) > 1) mesh.scale.set(r, 1, r);
  };
  /** Sea level and look: 'water' (default) or 'lava'. */
  mesh.userData.setSeaLevel = (y, kind = 'water') => {
    mesh.userData.level = y;
    mesh.userData.kind = kind;
    mesh.position.y = y;
    uniforms.uLava.value = kind === 'lava' ? 1 : 0;
    mat.transparent = kind !== 'lava';
    mat.depthWrite = kind === 'lava';
  };
  mesh.setSeaLevel = mesh.userData.setSeaLevel;
  return mesh;
}
