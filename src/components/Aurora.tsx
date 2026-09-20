import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import { readLevels, SPEECH_FLOOR } from '../lib/audio-levels'
import { glsl, TIME_WRAP } from '../../shared/voice/aurora.shader.ts'

// The aurora: one full-window canvas behind the app, running the shared fragment
// shader on raw WebGL. No library — a full-screen triangle, five uniforms and a
// rAF loop that switches itself off when nothing is making sound.
//
// The app's own surfaces (header, reader column, Composer) are opaque, so the
// wash only ever shows at the frame's edges — the shader's vignette does the rest.

const SPEECH_CEIL = 0.6 // a raised voice on a laptop mic reads about here
const SLEEP = 0.02 // level under this, with nothing else happening, stops the loop

const VERT = `attribute vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }
`

/** `#rrggbb` → three 0..1 floats. Anything unparseable reads as black, which is invisible. */
function rgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [0, 0, 0]
  const n = parseInt(m[1], 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** The two 7-stop ramps, read from the stylesheet so the theme owns them. */
function readPalettes(el: Element): { user: Float32Array; agent: Float32Array } {
  const css = getComputedStyle(el)
  const ramp = (name: string) => {
    const flat = new Float32Array(21)
    for (let i = 0; i < 7; i++) {
      const [r, g, b] = rgb(css.getPropertyValue(`--aurora-${name}-${i}`))
      flat[i * 3] = r
      flat[i * 3 + 1] = g
      flat[i * 3 + 2] = b
    }
    return flat
  }
  return { user: ramp('user'), agent: ramp('agent') }
}

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type)
  if (!sh) return null
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.warn('aurora shader failed', gl.getShaderInfoLog(sh))
    gl.deleteShader(sh)
    return null
  }
  return sh
}

export function Aurora() {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const gl = canvas.getContext('webgl', { alpha: true, antialias: false, depth: false })
    if (!gl) return // no WebGL: the app is just a quiet paper page, which is fine

    const vs = compile(gl, gl.VERTEX_SHADER, VERT)
    const fs = compile(gl, gl.FRAGMENT_SHADER, glsl())
    const program = vs && fs ? gl.createProgram() : null
    if (!vs || !fs || !program) return
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn('aurora link failed', gl.getProgramInfoLog(program))
      return
    }
    gl.useProgram(program)

    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(program, 'p')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)

    const uTime = gl.getUniformLocation(program, 'time')
    const uLevel = gl.getUniformLocation(program, 'level')
    const uThinking = gl.getUniformLocation(program, 'thinking')
    const uResolution = gl.getUniformLocation(program, 'resolution')
    const uPalette = gl.getUniformLocation(program, 'palette[0]')

    // premultiplied alpha out of the shader, over whatever the page paints
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.clearColor(0, 0, 0, 0)

    let palettes = readPalettes(document.documentElement)
    const mixed = new Float32Array(21)

    const resize = () => {
      // half of the device pixel ratio: a soft wash does not need the real grid,
      // and this is the one thing on screen that runs every frame.
      const scale = Math.max(0.5, (window.devicePixelRatio || 1) / 2)
      const w = Math.max(1, Math.round(window.innerWidth * scale))
      const h = Math.max(1, Math.round(window.innerHeight * scale))
      if (canvas.width === w && canvas.height === h) return
      canvas.width = w
      canvas.height = h
      gl.viewport(0, 0, w, h)
      gl.uniform2f(uResolution, w, h)
    }
    resize()

    const bars = new Float32Array(8)
    const start = performance.now()
    let level = 0
    let thinking = 0
    let who = 0 // 0 = the agent has the floor (cool), 1 = the user does (warm)
    let last = start
    let frame = 0
    let wake: ReturnType<typeof setInterval> | null = null

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')

    /** What the meters say right now, and who is making the sound. */
    const sample = (): { target: number; user: boolean } => {
      const { agentState, micEnabled, micMuted, playing } = useStore.getState()
      // the user interrupting outranks the agent — that's the whole point
      if (micEnabled && !micMuted) {
        const mic = readLevels('mic', bars)
        if (mic > SPEECH_FLOOR)
          return { target: Math.min(1, (mic - SPEECH_FLOOR) / (SPEECH_CEIL - SPEECH_FLOOR)), user: true }
      }
      if (agentState === 'speaking' || agentState === 'reading' || playing) {
        // the narration is levelled already; keep it a notch under a live voice
        return { target: Math.min(1, readLevels('output', bars) * 1.1) * 0.7, user: false }
      }
      return { target: 0, user: micEnabled && !micMuted }
    }

    const draw = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const { agentState, playing } = useStore.getState()
      const { target, user } = sample()

      // attack 0.3s, release 0.85s — the rise is the voice, the fall is a breath
      const k = target > level ? dt / 0.3 : dt / 0.85
      level += (target - level) * Math.min(1, k)
      thinking += ((agentState === 'thinking' ? 1 : 0) - thinking) * Math.min(1, dt / 0.6)
      who += ((user ? 1 : 0) - who) * Math.min(1, dt / 0.4)

      for (let i = 0; i < 21; i++) mixed[i] = palettes.agent[i] + (palettes.user[i] - palettes.agent[i]) * who

      gl.uniform1f(uTime, ((now - start) / 1000) % TIME_WRAP)
      gl.uniform1f(uLevel, level)
      gl.uniform1f(uThinking, thinking)
      gl.uniform3fv(uPalette, mixed)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.drawArrays(gl.TRIANGLES, 0, 3)

      // Nothing is making sound and nothing is pending: stop burning frames and
      // watch cheaply for the next level report instead.
      if (level < SLEEP && thinking < SLEEP && !playing && agentState === 'idle') {
        frame = 0
        if (!wake)
          wake = setInterval(() => {
            const { agentState: st, playing: p } = useStore.getState()
            if (sample().target > SLEEP || st !== 'idle' || p) resume()
          }, 200)
        return
      }
      frame = requestAnimationFrame(draw)
    }

    const resume = () => {
      if (frame || reduced.matches) return
      if (wake) {
        clearInterval(wake)
        wake = null
      }
      last = performance.now()
      frame = requestAnimationFrame(draw)
    }

    // Reduced motion: one static frame, redrawn only when the window changes.
    const still = () => {
      // whatever the loop was doing, it stops here — otherwise it keeps drawing
      // over the still frame we are about to paint
      if (frame) {
        cancelAnimationFrame(frame)
        frame = 0
      }
      gl.uniform1f(uTime, 0)
      gl.uniform1f(uLevel, 0)
      gl.uniform1f(uThinking, 0)
      gl.uniform3fv(uPalette, palettes.agent)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }

    const onResize = () => {
      resize()
      if (reduced.matches) still()
      else resume()
    }
    const onScheme = () => {
      palettes = readPalettes(document.documentElement)
      if (reduced.matches) still()
    }
    const scheme = window.matchMedia('(prefers-color-scheme: dark)')

    window.addEventListener('resize', onResize)
    scheme.addEventListener('change', onScheme)
    reduced.addEventListener('change', onResize)
    if (reduced.matches) still()
    else resume()

    return () => {
      window.removeEventListener('resize', onResize)
      scheme.removeEventListener('change', onScheme)
      reduced.removeEventListener('change', onResize)
      if (frame) cancelAnimationFrame(frame)
      if (wake) clearInterval(wake)
      // No loseContext() here: a canvas hands back the same context object every
      // time, so killing it on unmount also kills the one a remount would get
      // (React's development double-mount is exactly that). The context dies with
      // the canvas anyway.
    }
  }, [])

  return <canvas className="aurora" ref={ref} aria-hidden="true" />
}
