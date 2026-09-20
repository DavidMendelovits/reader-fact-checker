// Self-check for the two-platform shader source. Run it with:
//
//   node --experimental-strip-types shared/voice/aurora.check.ts
//
// Neither GPU is here, so this checks what a compiler error would not tell you in
// time: that the macro layer actually expanded, that one platform's vector type
// never leaks into the other's source, and that the uniform names the app binds
// by string still exist. A typo in a uniform name fails silently at runtime — the
// aurora just never moves.
import assert from 'node:assert/strict'
import { auroraBody, glsl, sksl } from './aurora.shader.ts'

const outputs = [
  ['sksl', sksl()],
  ['glsl', glsl()],
] as const

for (const [name, src] of outputs) {
  for (const uniform of ['time', 'level', 'thinking', 'resolution', 'palette']) {
    assert.match(src, new RegExp(`uniform [a-z0-9]+ ${uniform}\\b`), `${name}: no ${uniform} uniform`)
  }
  assert.equal(src.match(/\{/g)?.length, src.match(/\}/g)?.length, `${name}: unbalanced braces`)
  assert.equal(src.match(/\(/g)?.length, src.match(/\)/g)?.length, `${name}: unbalanced parens`)
  assert.doesNotMatch(src, /\bVEC[234]\b/, `${name}: unexpanded macro token`)
  // the body is actually in there, and reachable from the entry point
  assert.ok(src.includes('float aFbm('), `${name}: lost the noise`)
  assert.ok(src.includes('float aEdge('), `${name}: lost the vignette`)
  assert.ok(src.includes('aurora(') , `${name}: entry point never calls the body`)
  for (let i = 0; i < 7; i++) assert.ok(src.includes(`palette[${i}]`), `${name}: palette stop ${i} unused`)
}

// the macro layer is the only difference: each platform's spelling, and never the other's
const [, skslSrc] = outputs[0]
const [, glslSrc] = outputs[1]
assert.ok(skslSrc.includes('half4 main(float2 fragCoord)'), 'sksl: wrong entry point')
assert.ok(skslSrc.includes('float3 c = aPalette('), 'sksl: body not expanded to float3')
assert.doesNotMatch(skslSrc, /\bvec[234]\b/, 'sksl: GLSL vector types leaked in')
assert.ok(glslSrc.includes('void main()') && glslSrc.includes('gl_FragColor'), 'glsl: wrong entry point')
assert.ok(glslSrc.includes('precision mediump float;'), 'glsl: no precision qualifier')
assert.ok(glslSrc.includes('vec3 c = aPalette('), 'glsl: body not expanded to vec3')
assert.doesNotMatch(glslSrc, /\bfloat[234]\b/, 'glsl: SkSL vector types leaked in')

// the body itself is written in macros, or the expansion is a no-op that hides a typo
assert.match(auroraBody, /\bVEC2\b/)
assert.match(auroraBody, /\bVEC3\b/)
assert.match(auroraBody, /\bVEC4\b/)

console.log('aurora: ok')
