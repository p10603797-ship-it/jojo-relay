import * as THREE from 'three';

export const SUN_DIR = new THREE.Vector3(-0.42, 0.74, 0.52).normalize();
export const SKY_COLORS = {
  zenith: new THREE.Color(0x2b78de),
  horizon: new THREE.Color(0xbfe0fb),
  fog: new THREE.Color(0xb9daf5),
};

/** Gradient sky dome with sun and drifting procedural clouds. */
export function createSky(noiseTex, radius = 400) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uSun: { value: SUN_DIR },
      uZenith: { value: SKY_COLORS.zenith },
      uHorizon: { value: SKY_COLORS.horizon },
      uTime: { value: 0 },
      uNoise: { value: noiseTex },
      uClouds: { value: 1 },
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        // pin the dome to the far plane so it is never clipped, whatever the draw distance
        gl_Position = vec4(p.xy, p.w * 0.99999, p.w);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uSun, uZenith, uHorizon;
      uniform float uTime, uClouds;
      uniform sampler2D uNoise;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        float t = pow(clamp(h, 0.0, 1.0), 0.42);
        vec3 col = mix(uHorizon, uZenith, t);
        col = mix(col, uHorizon * vec3(0.72, 0.84, 0.95), smoothstep(0.0, -0.2, h));
        float sd = max(dot(d, uSun), 0.0);
        col += vec3(1.0, 0.86, 0.62) * (pow(sd, 5.0) * 0.16 + pow(sd, 60.0) * 0.35);
        if (h > 0.0 && uClouds > 0.0) {
          vec2 uv = d.xz / (h + 0.14) * 0.32 + vec2(uTime * 0.0035, uTime * 0.0012);
          float n = texture2D(uNoise, uv).r * 0.62 + texture2D(uNoise, uv * 2.9 + 0.37).g * 0.38;
          float c = smoothstep(0.5, 0.78, n) * smoothstep(0.0, 0.2, h);
          vec3 cc = mix(vec3(0.74, 0.8, 0.9), vec3(1.08), smoothstep(0.52, 0.86, n));
          cc += vec3(1.0, 0.88, 0.66) * pow(sd, 6.0) * 0.35;
          col = mix(col, cc, c * 0.92);
        }
        col += vec3(1.0, 0.95, 0.82) * smoothstep(0.9993, 0.99965, sd) * 8.0;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), mat);
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;
  mesh.name = 'sky';
  return mesh;
}
