// One aurora, two GPUs. Skia (SkSL) on the phone, WebGL (GLSL ES 1.0) in the
// browser. The two languages differ in exactly three places — the vector type
// names, the uniform header and how the fragment returns — so the body is written
// once with VEC2/VEC3/VEC4 tokens and each platform's preamble is prepended.
//
// ponytail: string replacement, not a shader compiler. It holds because the body
// deliberately stays inside the intersection of the two languages: no loops, no
// array indexing by a variable, no built-in either side lacks.
//
// UNIFORMS (identical names and layout on both platforms):
//   time       float   seconds since the layer mounted
//   level      float   0..1 mic/voice level, attack 0.3s release 0.85s
//   thinking   float   0..1 how much the curtains gather into a sweeping band
//   resolution VEC2    layer size in pixels
//   palette    VEC3[7] the theme's aurora ramp, warm for the user, cool for the agent
//
// palette is a 7-element vec3 array because both bindings take the same flat
// 21-float buffer: Skia's `useMemo(() => ({ palette: [r,g,b, r,g,b, ...] }))` and
// WebGL's `gl.uniform3fv(loc, flat)`. It is only ever indexed by a literal, which
// is what GLSL ES 1.0 requires of a fragment-shader array.
//
// The result is premultiplied (rgb already multiplied by a): SkSL's half4 main
// returns premultiplied colour, and the web layer is drawn with
// blendFunc(ONE, ONE_MINUS_SRC_ALPHA).

export const auroraBody = `
float aHash(VEC2 p) {
  return fract(sin(dot(p, VEC2(127.1, 311.7))) * 43758.5453123);
}

float aNoise(VEC2 p) {
  VEC2 i = floor(p);
  VEC2 f = fract(p);
  VEC2 u = f * f * (3.0 - 2.0 * f);
  float a = aHash(i);
  float b = aHash(i + VEC2(1.0, 0.0));
  float c = aHash(i + VEC2(0.0, 1.0));
  float d = aHash(i + VEC2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// three octaves: enough for curtains, cheap enough to run every frame on a phone
float aFbm(VEC2 p) {
  float v = 0.0;
  v = v + 0.500 * aNoise(p);
  p = p * 2.02;
  v = v + 0.250 * aNoise(p);
  p = p * 2.03;
  v = v + 0.125 * aNoise(p);
  return v / 0.875;
}

// 1.0 hard against any of the four edges, 0.0 by 12% of the shorter side inward.
// This is the guardrail: the reader column never sits on the wash.
float aEdge(VEC2 fragCoord) {
  float band = 0.12 * min(resolution.x, resolution.y);
  float dx = min(fragCoord.x, resolution.x - fragCoord.x);
  float dy = min(fragCoord.y, resolution.y - fragCoord.y);
  float t = clamp(min(dx, dy) / max(band, 1.0), 0.0, 1.0);
  return 1.0 - (t * t * (3.0 - 2.0 * t));
}

// Seven stops, walked with literal indices so GLSL ES 1.0 is happy.
VEC3 aPalette(float t) {
  float s = clamp(t, 0.0, 1.0) * 6.0;
  VEC3 c = palette[0];
  c = mix(c, palette[1], clamp(s, 0.0, 1.0));
  c = mix(c, palette[2], clamp(s - 1.0, 0.0, 1.0));
  c = mix(c, palette[3], clamp(s - 2.0, 0.0, 1.0));
  c = mix(c, palette[4], clamp(s - 3.0, 0.0, 1.0));
  c = mix(c, palette[5], clamp(s - 4.0, 0.0, 1.0));
  c = mix(c, palette[6], clamp(s - 5.0, 0.0, 1.0));
  return c;
}

VEC4 aurora(VEC2 fragCoord) {
  VEC2 uv = fragCoord / resolution;
  float drift = time * 0.06;

  // curtains: fbm warped by fbm, drifting upward
  VEC2 q = VEC2(uv.x * 2.4, uv.y * 1.6 - drift);
  float warp = aFbm(q * 1.7 + VEC2(drift * 0.5, 0.0));
  float n = aFbm(q + VEC2(warp * 0.6, warp * 0.35));

  // thinking gathers the curtains into one band sweeping across the frame
  float sweep = 1.0 - clamp(abs(uv.y - (0.5 + 0.28 * sin(time * 0.9))) * 3.2, 0.0, 1.0);
  n = mix(n, 0.45 * n + 0.55 * sweep, clamp(thinking, 0.0, 1.0));

  // at rest a tenth of an aurora; the voice is what makes it one
  float amp = 0.10 + 0.75 * clamp(level, 0.0, 1.0);
  float a = clamp(n * aEdge(fragCoord) * amp, 0.0, 1.0);
  VEC3 c = aPalette(n * 0.75 + uv.x * 0.25);
  return VEC4(c * a, a);
}
`

const SKSL_PREAMBLE = `uniform float time;
uniform float level;
uniform float thinking;
uniform float2 resolution;
uniform float3 palette[7];
`

const GLSL_PREAMBLE = `precision mediump float;
uniform float time;
uniform float level;
uniform float thinking;
uniform vec2 resolution;
uniform vec3 palette[7];
`

const expand = (src: string, v2: string, v3: string, v4: string) =>
  src.replace(/\bVEC2\b/g, v2).replace(/\bVEC3\b/g, v3).replace(/\bVEC4\b/g, v4)

/** Skia runtime effect source, for `Skia.RuntimeEffect.Make()`. */
export function sksl(): string {
  return `${SKSL_PREAMBLE}${expand(auroraBody, 'float2', 'float3', 'float4')}
half4 main(float2 fragCoord) {
  return half4(aurora(fragCoord));
}
`
}

/** WebGL fragment shader source (GLSL ES 1.0), paired with a full-screen triangle. */
export function glsl(): string {
  return `${GLSL_PREAMBLE}${expand(auroraBody, 'vec2', 'vec3', 'vec4')}
void main() {
  gl_FragColor = aurora(gl_FragCoord.xy);
}
`
}
