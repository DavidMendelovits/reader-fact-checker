// The ear the app runs on: the streaming vendor when the server offers one,
// otherwise the browser's own recognizer. Chosen once, the first time the mic
// goes on, so a page with no vendor configured asks the server one question.
//
// The app sets its handlers on this object once (controller.ts); both ears call
// back through it, so the choice can be made late.
import type { Transcriber } from './ports.ts'

export type Preferred = Transcriber & { available(): Promise<boolean> }

export class FirstAvailable implements Transcriber {
  readonly supported: boolean
  private choosing: Promise<Transcriber> | null = null
  private active: Transcriber | null = null
  private wanted = false

  onUtterance: (text: string) => void = () => {}
  onInterim: (text: string) => void = () => {}
  onSpeechStart: () => void = () => {}
  onFalseStart: () => void = () => {}
  onError: (msg: string) => void = () => {}
  getSpokenText: () => string = () => ''
  getRecentSpokenText: () => string = () => ''

  constructor(
    private preferred: Preferred,
    private fallback: Transcriber,
  ) {
    this.supported = preferred.supported || fallback.supported
    for (const t of [preferred, fallback]) {
      t.onUtterance = (s) => this.onUtterance(s)
      t.onInterim = (s) => this.onInterim(s)
      t.onSpeechStart = () => this.onSpeechStart()
      t.onFalseStart = () => this.onFalseStart()
      t.onError = (m) => this.onError(m)
      t.getSpokenText = () => this.getSpokenText()
      t.getRecentSpokenText = () => this.getRecentSpokenText()
    }
  }

  // ponytail: the choice holds for the page. A vendor configured, or a grant that
  // failed once, after the first mic tap takes a reload to pick up.
  async start() {
    this.wanted = true
    this.choosing ??= this.preferred.available().then((ok) => (ok ? this.preferred : this.fallback))
    const t = await this.choosing
    if (!this.wanted) return // the mic went off while the server was answering
    if (!t.supported) return this.onError("Voice input isn't available in this browser")
    this.active = t
    return t.start()
  }

  stop() {
    this.wanted = false
    this.active?.stop()
    this.active = null
  }

  setUserMuted(muted: boolean) {
    this.preferred.setUserMuted(muted)
    this.fallback.setUserMuted(muted)
  }

  setPlaying(playing: boolean) {
    this.preferred.setPlaying(playing)
    this.fallback.setPlaying(playing)
  }
}
