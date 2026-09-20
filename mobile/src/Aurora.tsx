// The aurora, on the phone's GPU. One SkSL fragment shader — the body in
// shared/voice/aurora.shader.ts, the same one the web layer compiles as GLSL —
// filling the screen behind everything, with its uniforms driven from Reanimated
// shared values so that not one frame of it touches the JS thread while a page is
// being narrated.
//
// What drives what:
//   level     the voice. The mic while the user talks (it outranks the agent —
//             that is the whole point of barge-in), a soft pulse while the agent
//             reads, a steady 0.35 while it thinks, nothing at rest. Smoothed on
//             the UI thread, attack 0.3s / release 0.85s.
//   thinking  0→1 over 600ms; the shader gathers the curtains into a sweeping band.
//   palette   the theme's warm ramp while the user talks, the cool one otherwise,
//             cross-faded over 400ms. 21 floats, the flat buffer Skia binds a
//             float3[7] from.
//   time      seconds since the layer mounted, advanced per frame on the UI thread.
//
// Rest opacity is the shader's own business: its amplitude is `0.10 + 0.75 * level`,
// so at level 0 nothing it draws can exceed 10% alpha. No outer opacity here.
//
// Three economies, in the order they matter:
//   HALF RES   the Canvas is laid out at half the screen in each direction and
//              scaled 2×, so the fragment shader runs over a quarter of the pixels.
//              The vignette is a fraction of the shorter side, so it lands in the
//              same place either way.
//              ponytail: the upscale is the view's own bilinear filter, and the
//              ceiling is that it would show on a hard edge. The aurora has none —
//              fbm through a smoothstep vignette is all gradient — so nothing here
//              renders at full resolution to find out.
//   PAUSE      when there is nothing to show — level below 0.02, not thinking, not
//              playing — the frame callback is switched off. `time` stops, every
//              uniform stops changing, and Skia stops redrawing: an idle reader
//              costs no GPU at all. The 80ms sampler switches it back on.
//   SAMPLING   the store and the mic are read on an 80ms interval (the cadence the
//              recognizer reports at), never per frame, and never into React state.
import { useEffect, useMemo, useRef, useState } from 'react'
import { AccessibilityInfo, StyleSheet, useWindowDimensions, View } from 'react-native'
import { Canvas, Fill, Shader, Skia } from '@shopify/react-native-skia'
import { Easing, useDerivedValue, useFrameCallback, useSharedValue, withTiming } from 'react-native-reanimated'
import { sksl } from '../../shared/voice/aurora.shader'
import { getMicLevel } from './levels'
import { useStore } from './store'
import { useTheme } from './theme'

const SAMPLE_MS = 80
const ATTACK_S = 0.3
const RELEASE_S = 0.85
const MIC_FLOOR = 0.05 // below this the recognizer is hearing the room, not a voice
const REST = 0.02 // level under which the aurora is indistinguishable from frozen
const THINKING_LEVEL = 0.35
const PULSE_W = 2 * Math.PI / 1.1 // the reading pulse, 0.28 ± 0.12, one turn every 1.1s
const REDUCED_LEVEL = 0.15

// What the level is following this moment. A number so the worklet can switch on it.
const SILENT = 0
const USER = 1
const AGENT = 2
const THINKING = 3

/** '#rrggbb' → three 0..1 components, the units both shaders' palettes are in. */
function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.trim().replace(/^#/, ''), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** The theme's seven stops as the flat 21-float buffer the uniform takes. */
function ramp(stops: string[]): number[] {
  const out: number[] = []
  for (let i = 0; i < 7; i++) out.push(...rgb(stops[i % stops.length]))
  return out
}

export default function Aurora() {
  const { width, height } = useWindowDimensions()
  const theme = useTheme()
  const [reduced, setReduced] = useState(false)
  const effect = useMemo(() => Skia.RuntimeEffect.Make(sksl()), [])
  const warm = useMemo(() => ramp(theme.auroraUser), [theme])
  const cool = useMemo(() => ramp(theme.auroraAgent), [theme])
  const halfW = Math.round(width / 2)
  const halfH = Math.round(height / 2)

  const time = useSharedValue(0)
  const level = useSharedValue(0)
  const thinking = useSharedValue(0)
  const warmth = useSharedValue(0) // 0 the agent's cool ramp, 1 the user's warm one
  const mode = useSharedValue(SILENT)
  const mic = useSharedValue(0)

  useEffect(() => {
    let live = true
    void AccessibilityInfo.isReduceMotionEnabled().then((on) => live && setReduced(on))
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced)
    return () => {
      live = false
      sub.remove()
    }
  }, [])

  // The only per-frame work, and it happens on the UI thread: advance the clock and
  // ease the level toward whatever the sampler last said it was following.
  const frame = useFrameCallback((info) => {
    'worklet'
    const dt = Math.min(0.05, (info.timeSincePreviousFrame ?? 16) / 1000)
    time.value += dt
    const target =
      mode.value === USER ? Math.min(1, mic.value * 1.15)
      : mode.value === AGENT ? 0.28 + 0.12 * Math.sin(time.value * PULSE_W)
      : mode.value === THINKING ? THINKING_LEVEL
      : 0
    const tau = target > level.value ? ATTACK_S : RELEASE_S
    level.value += (target - level.value) * Math.min(1, dt / tau)
  }, false)

  // Reduced motion: one still wash, no drift, no pulse. The frame callback never runs.
  useEffect(() => {
    if (!reduced) return
    level.value = REDUCED_LEVEL
    thinking.value = 0
    frame.setActive(false)
  }, [reduced, level, thinking, frame])

  // The sampler. Everything React and zustand know about the voice enters here, at
  // 12.5Hz, and leaves as shared values.
  const sent = useRef({ warmth: 0, thinking: 0, active: false })
  useEffect(() => {
    if (reduced) return
    const id = setInterval(() => {
      const { agentState, micEnabled, playing } = useStore.getState()
      const heard = micEnabled ? getMicLevel() : 0
      mic.value = heard
      const next =
        heard > MIC_FLOOR ? USER
        : agentState === 'speaking' || agentState === 'reading' || playing ? AGENT
        : agentState === 'thinking' ? THINKING
        : SILENT
      if (next !== mode.value) mode.value = next

      const toWarm = next === USER ? 1 : 0
      if (toWarm !== sent.current.warmth) {
        sent.current.warmth = toWarm
        warmth.value = withTiming(toWarm, { duration: 400, easing: Easing.inOut(Easing.quad) })
      }
      const toThink = agentState === 'thinking' ? 1 : 0
      if (toThink !== sent.current.thinking) {
        sent.current.thinking = toThink
        thinking.value = withTiming(toThink, { duration: 600, easing: Easing.inOut(Easing.quad) })
      }
      // PAUSE: nothing to follow and the release has run out — let the GPU idle.
      const active = next !== SILENT || level.value >= REST
      if (active !== sent.current.active) {
        sent.current.active = active
        frame.setActive(active)
      }
    }, SAMPLE_MS)
    return () => clearInterval(id)
  }, [reduced, frame, mic, mode, thinking, warmth, level])

  const uniforms = useDerivedValue(() => {
    const palette: number[] = []
    for (let i = 0; i < 21; i++) palette.push(cool[i] + (warm[i] - cool[i]) * warmth.value)
    return {
      time: time.value,
      level: level.value,
      thinking: thinking.value,
      resolution: [halfW, halfH],
      palette,
    }
  }, [warm, cool, halfW, halfH])

  if (!effect || halfW < 1 || halfH < 1) return null
  return (
    <View
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {/* Half the pixels: laid out at half size, centred, and scaled back up. */}
      <Canvas style={{ position: 'absolute', left: halfW / 2, top: halfH / 2, width: halfW, height: halfH, transform: [{ scale: 2 }] }}>
        <Fill>
          <Shader source={effect} uniforms={uniforms} />
        </Fill>
      </Canvas>
    </View>
  )
}
