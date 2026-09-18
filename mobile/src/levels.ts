// The microphone level, as the speech recognizer reports it, for anything that
// wants to draw it (the voice glow). A plain module rather than store state:
// it moves ten times a second and nothing should re-render for that.
//
// The recognizer's `volumechange` runs -2..10 with anything below 0 inaudible;
// this keeps a 0..1 figure and forgets it when the reports stop, so a paused
// recognizer reads as silence rather than the last thing it heard.

let level = 0
let at = 0
const STALE_MS = 400

export function setMicLevel(raw: number): void {
  level = Math.max(0, Math.min(1, raw / 10))
  at = Date.now()
}

export function getMicLevel(): number {
  return Date.now() - at > STALE_MS ? 0 : level
}
