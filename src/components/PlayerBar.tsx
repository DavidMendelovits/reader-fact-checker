import { useStore } from '../store'
import { play, pause, setMicEnabled, setMicMuted, checkWholeDocument, cancelDocumentCheck } from '../lib/controller'
import { tts, voice } from '../lib/providers'

const RATES = [0.8, 1, 1.2, 1.5, 2]

export function PlayerBar() {
  const s = useStore()
  if (!s.doc) return null

  // The agent can set any rate in [0.5, 3] ("one point seven five times"). Showing
  // it needs an option to select, or the control silently displays a different speed
  // than the one playing.
  const rates = RATES.includes(s.rate) ? RATES : [...RATES, s.rate].sort((a, b) => a - b)

  return (
    <div className="player-bar">
      <button className="play-btn" onClick={() => (s.playing ? pause() : play())}>
        {s.playing ? '⏸ Pause' : '▶ Play'}
      </button>

      <span className="position">
        ¶ {s.currentParagraph + 1} / {s.paragraphs.length}
      </span>

      <label>
        Speed
        <select
          value={s.rate}
          onChange={(e) => {
            const rate = Number(e.target.value)
            s.setRate(rate)
            tts.setRate(rate)
          }}
        >
          {rates.map((r) => (
            <option key={r} value={r}>{r}×</option>
          ))}
        </select>
      </label>

      <button
        className={s.micEnabled ? 'mic on' : 'mic'}
        disabled={!voice.supported}
        title={voice.supported ? 'Talk to the reader hands-free' : 'SpeechRecognition unsupported (use Chrome)'}
        onClick={() => setMicEnabled(!s.micEnabled)}
      >
        {s.micEnabled ? '🎙 Listening' : '🎙 Enable mic'}
      </button>

      {s.micEnabled && (
        <button
          className={s.micMuted ? 'mute on' : 'mute'}
          title={s.micMuted ? 'Unmute the microphone' : 'Mute the microphone'}
          onClick={() => setMicMuted(!s.micMuted)}
        >
          {s.micMuted ? '🔇 Muted' : '🔈 Mute'}
        </button>
      )}

      {s.docCheckProgress ? (
        <button onClick={cancelDocumentCheck}>
          ✕ Checking… {s.docCheckProgress.done}/{s.docCheckProgress.total}
        </button>
      ) : (
        <button onClick={() => void checkWholeDocument()}>Fact check whole document</button>
      )}

      <button className="back" onClick={() => { pause(); s.clearDoc() }}>← New document</button>
    </div>
  )
}
