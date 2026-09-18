// The voice glow, natively: coloured light along the bottom of the screen that
// rises with the user's voice, gathers into a beam that sweeps side to side
// while the agent is thinking, and pulses gently while it speaks. The same
// three states as the web app's (src/components/VoiceGlow.tsx, on the
// voice-glow package), rebuilt here because there is no DOM: seven soft lobes
// of colour (radial gradients in an SVG) on a layer the UI thread scales and
// slides, so it never contends with the reader for the JS thread while a page
// is being narrated.
import { useEffect, useId, useMemo, useRef } from 'react'
import { Animated, Easing, Platform, StyleSheet, useWindowDimensions, View } from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import Svg, { Defs, Ellipse, RadialGradient, Stop } from 'react-native-svg'
import { getMicLevel } from './levels'
import { useStore } from './store'

// voice-glow's light palette: gold, sky, violet, rose, peach, periwinkle, aqua
const PALETTE = ['#ffc915', '#7ec4ff', '#b428e6', '#eb64a0', '#ffb07a', '#9aa0ff', '#7fd9ee']
// the agent's own voice in cooler tones, so who has the floor reads at a glance
const AGENT_PALETTE = ['#7ec4ff', '#9aa0ff', '#5fb8e0', '#8a7cf0', '#6fd3f2', '#a3b4ff', '#7fd9ee']

const HEIGHT = 200 // the glow's full reach, px
const MIN_RISE = 0.3 // resting height as a share of the reach
const IDLE = 0.14 // resting presence: breathes this much while silent
const BREATHE_S = 5.2
const ATTACK_S = 0.3
const RELEASE_S = 0.85
const PROCESSING_LEVEL = 0.35
const SWEEP_MS = 1050
const FLOW_S = 14 // one full turn of the colours across the screen

const native = Platform.OS !== 'web'

export function VoiceGlow() {
  const { width } = useWindowDimensions()
  const thinking = useStore((s) => s.agentState === 'thinking')
  const agentTalking = useStore((s) => s.agentState === 'speaking' || s.agentState === 'reading' || s.playing)

  // driven from a frame loop, never through React state
  const level = useRef(new Animated.Value(0)).current
  const flow = useRef(new Animated.Value(0)).current
  const sweep = useRef(new Animated.Value(0)).current
  const beam = useRef(new Animated.Value(0)).current

  // the level: smooth what the mic and the state say toward a 0..1 figure
  useEffect(() => {
    let frame = 0
    let last = 0
    let shown = 0
    let t = 0
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick)
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60
      last = now
      t += dt
      const { agentState, micEnabled, playing } = useStore.getState()
      const mic = micEnabled ? getMicLevel() : 0
      let target = 0
      if (mic > 0.05) {
        // the user interrupting outranks the agent — that's the whole point
        target = Math.min(1, mic * 1.15)
      } else if (agentState === 'speaking' || agentState === 'reading' || playing) {
        // no meter on the narration; a soft pulse in time with speech cadence
        target = 0.28 + 0.12 * Math.sin(t * 5.3) + 0.06 * Math.sin(t * 8.9 + 1)
      } else if (agentState === 'thinking') {
        target = PROCESSING_LEVEL
      }
      const tau = target > shown ? ATTACK_S : RELEASE_S
      shown += (target - shown) * Math.min(1, dt / tau)
      const breathe = 0.5 + 0.5 * Math.sin((2 * Math.PI * t) / BREATHE_S)
      level.setValue(shown + (1 - shown) * IDLE * breathe)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [level])

  // the colours drift sideways forever, so every colour takes a turn at the centre
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(flow, { toValue: 1, duration: FLOW_S * 1000, easing: Easing.linear, useNativeDriver: native }),
    )
    loop.start()
    return () => loop.stop()
  }, [flow])

  // thinking: the glow gathers into one beam that travels left to right and back
  useEffect(() => {
    Animated.timing(beam, { toValue: thinking ? 1 : 0, duration: 600, easing: Easing.inOut(Easing.quad), useNativeDriver: native }).start()
    if (!thinking) return
    sweep.setValue(0.5)
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(sweep, { toValue: 1, duration: SWEEP_MS / 2, easing: Easing.out(Easing.quad), useNativeDriver: native }),
        Animated.timing(sweep, { toValue: 0, duration: SWEEP_MS, easing: Easing.inOut(Easing.quad), useNativeDriver: native }),
        Animated.timing(sweep, { toValue: 0.5, duration: SWEEP_MS / 2, easing: Easing.in(Easing.quad), useNativeDriver: native }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [thinking, beam, sweep])

  const colors = agentTalking ? AGENT_PALETTE : PALETTE
  const ribbon: [string, string, ...string[]] = [colors[0], colors[1], ...colors.slice(2), ...colors, ...colors, colors[0]]
  // one period of the colour ring; the ribbon carries three so it can slide a
  // full period and loop without a seam
  const period = width * 1.25
  const beamWidth = width * 0.6
  const styles = useMemo(() => {
    // the layer scales from its bottom edge: shrink and slide down in step
    const rise = level.interpolate({ inputRange: [0, 1], outputRange: [MIN_RISE, 1] })
    const settle = level.interpolate({ inputRange: [0, 1], outputRange: [(HEIGHT * (1 - MIN_RISE)) / 2, 0] })
    const spread = level.interpolate({ inputRange: [0, 1], outputRange: [0.88, 1.1] })
    const glowOpacity = Animated.multiply(
      level.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] }),
      beam.interpolate({ inputRange: [0, 1], outputRange: [1, 0.3] }),
    )
    const slide = flow.interpolate({ inputRange: [0, 1], outputRange: [0, -period] })
    const travel = sweep.interpolate({ inputRange: [0, 1], outputRange: [-width * 0.3, width * 0.3] })
    return { rise, settle, spread, glowOpacity, slide, travel }
  }, [level, beam, flow, sweep, width, period])

  return (
    <View pointerEvents="none" style={sheet.root} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {/* the voice: a ring of soft lobes along the edge */}
      <Animated.View
        style={[
          sheet.layer,
          { width, opacity: styles.glowOpacity },
          { transform: [{ translateY: styles.settle }, { scaleY: styles.rise }, { scaleX: styles.spread }] },
        ]}
      >
        <Animated.View style={[sheet.ribbon, { width: period * 3, left: -period, transform: [{ translateX: styles.slide }] }]}>
          <Lobes colors={colors} period={period} copies={3} height={HEIGHT} />
        </Animated.View>
      </Animated.View>
      {/* thinking: one compact beam on the move */}
      <Animated.View style={[sheet.layer, { width: beamWidth, left: (width - beamWidth) / 2, opacity: beam }, { transform: [{ translateX: styles.travel }] }]}>
        <Lobes colors={[colors[2], colors[0], colors[3]]} period={beamWidth} copies={1} height={HEIGHT * 0.6} />
      </Animated.View>
      {/* the band: a crisp line of colour along the edge itself */}
      <Animated.View style={[sheet.band, { opacity: styles.glowOpacity }]}>
        <Animated.View style={[sheet.ribbon, { width: period * 3, left: -period, transform: [{ translateX: styles.slide }] }]}>
          <LinearGradient
            colors={ribbon}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      </Animated.View>
    </View>
  )
}

/**
 * The lobes: one soft ellipse per colour, centred on the bottom edge so only
 * its top half shows, each fading radially to nothing — no hard outline
 * anywhere, and neighbours overlap into one wash of colour.
 */
function Lobes({ colors, period, copies, height }: { colors: string[]; period: number; copies: number; height: number }) {
  // gradient ids are document-wide, and there are two of these on screen
  const id = useId().replace(/[^a-zA-Z0-9]/g, '')
  const n = colors.length
  const step = period / n
  const rx = step * 1.1
  const ry = height * 0.95
  // room for the end lobes, which reach past the period on either side
  const width = period * copies + 2 * rx
  return (
    <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ marginLeft: -rx }}>
      <Defs>
        {colors.map((c, i) => (
          <RadialGradient key={i} id={`lobe-${id}-${i}`} cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={c} stopOpacity={0.9} />
            <Stop offset="0.45" stopColor={c} stopOpacity={0.45} />
            <Stop offset="1" stopColor={c} stopOpacity={0} />
          </RadialGradient>
        ))}
      </Defs>
      {Array.from({ length: n * copies }, (_, i) => (
        <Ellipse key={i} cx={rx + (i + 0.5) * step} cy={height} rx={rx} ry={ry} fill={`url(#lobe-${id}-${i % n})`} />
      ))}
    </Svg>
  )
}

const sheet = StyleSheet.create({
  root: { position: 'absolute', left: 0, right: 0, bottom: 0, height: HEIGHT, overflow: 'hidden' },
  layer: { position: 'absolute', bottom: 0, left: 0, height: HEIGHT, justifyContent: 'flex-end' },
  ribbon: { position: 'absolute', bottom: 0 },
  band: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, overflow: 'hidden' },
})
