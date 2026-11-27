// The ear the app runs on: the streaming vendor when the server offers one,
// otherwise the browser's own recognizer. Chosen the first time the mic goes on
// and the server gives a clear answer, so a page with no vendor configured asks
// one question. A server that couldn't answer is asked again on the next tap.
//
// The app sets its handlers on this object once (controller.ts); both ears call
// back through it, so the choice can be made late.
import type { Transcriber } from './ports.ts'

/** A Transcriber that can say whether it is usable here: yes, no, or null for couldn't tell just now. */
export type Preferred = Transcriber & { available(): Promise<boolean | null> }

export class FirstAvailable implements Transcriber {
  private choosing: Promise<boolean | null> | null = null
  private choice: Transcriber | null = null
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

  /**
   * Before the first tap, whether either ear could work here; after it, whether
   * the chosen one does. Composer reads this on render, so a browser that turns
   * out to have neither shows its "needs Chrome" hint from then on.
   */
  get supported(): boolean {
    return this.choice ? this.choice.supported : this.preferred.supported || this.fallback.supported
  }

  // ponytail: a clear answer holds for the page, so a vendor configured after the
  // first mic tap takes a reload to pick up.
  async start() {
    this.wanted = true
    let t = this.choice
    if (!t) {
      this.choosing ??= this.preferred.available()
      const ok = await this.choosing
      this.choosing = null
      t = ok ? this.preferred : this.fallback
      if (ok !== null) this.choice ??= t
      else if (!t.supported) {
        // couldn't reach the server, and there is nothing to fall back on here
        if (this.wanted) this.onError("Couldn't reach speech input. Tap the mic to try again.")
        return
      }
    }
    if (!this.wanted) return // the mic went off while the server was answering
    if (!t.supported) return this.onError('Mic needs Chrome — type instead') // Composer's own hint for a browser without speech input
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
