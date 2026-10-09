// Colour grade applied to the renderer once at boot (tone mapping and exposure). No extra passes:
// the grade is three.js's CustomToneMapping hook, so it runs at the end of every material's own
// fragment shader.
//   - exposure
//   - vibrance 0.12: dull colours get a little more saturated, strong ones are left alone
//   - split tone: shadows a touch cooler, highlights a touch warmer
//   - a hue-preserving shoulder: the brightest channel is compressed and the others scaled with
//     it, so a bright blue sky stays blue (instead of washing toward cyan/white like ACES)
import * as THREE from 'three';

export const GRADE = { exposure: 1.12, vibrance: 0.12, knee: 0.62 };

const CHUNK = /* glsl */`
vec3 CustomToneMapping( vec3 color ) {
  color *= toneMappingExposure;
  float luma = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );
  float mx = max( color.r, max( color.g, color.b ) ), mn = min( color.r, min( color.g, color.b ) );
  float sat = ( mx - mn ) / max( mx, 1e-4 );
  color = max( mix( vec3( luma ), color, 1.0 + ${GRADE.vibrance.toFixed(3)} * ( 1.0 - sat ) ), 0.0 );
  color *= mix( vec3( 0.975, 0.995, 1.035 ), vec3( 1.03, 1.0, 0.965 ), smoothstep( 0.04, 0.7, luma ) );
  float peak = max( color.r, max( color.g, color.b ) );
  const float K = ${GRADE.knee.toFixed(3)};
  float mapped = peak <= K ? peak : K + ( 1.0 - K ) * ( 1.0 - exp( -( peak - K ) / ( 1.0 - K ) ) );
  color *= mapped / max( peak, 1e-4 );
  // the very brightest highlights drift a little toward white, like film
  float w = smoothstep( 0.86, 1.0, mapped );
  return mix( color, vec3( mapped ), w * 0.35 );
}`;

let installed = false;

/**
 * @param {import('three').WebGLRenderer} renderer
 * @param {object} [quality]   the quality preset (main.js PRESETS entry plus its name)
 */
export function applyGrade(renderer, quality) {
  if (!renderer || !THREE.ShaderChunk) return;
  if (!installed) {
    const src = THREE.ShaderChunk.tonemapping_pars_fragment;
    // replace the stock CustomToneMapping (it returns the colour unchanged) with the grade
    const re = /vec3 CustomToneMapping\( vec3 color \) \{[^}]*\}/;
    if (src && re.test(src)) {
      THREE.ShaderChunk.tonemapping_pars_fragment = src.replace(re, CHUNK.trim());
      installed = true;
    }
  }
  if (!installed) return;
  renderer.toneMapping = THREE.CustomToneMapping;
  renderer.toneMappingExposure = GRADE.exposure;
  void quality;
}
