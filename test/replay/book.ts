// The book every replay run reads from: a short original story, so the corpus
// can name paragraphs, chapters and lines and say exactly which call is right.
// It carries two real-world claims (paragraphs 2 and 6) for the fact checks.
import type { AgentContext } from '../../api/_lib/agent.ts'

export const PARAGRAPHS = [
  'Marta took the keeper\'s post on the island in the spring, when the gulls were loud and the supply boat still came every week.',
  'The lighthouse had been built in 1874, and its lamp had burned paraffin for half a century before anyone ran a cable across the strait.',
  'The first electric light in a British lighthouse, she had read, was lit at South Foreland in 1858, using a steam-driven generator.',
  'Her predecessor left one note pinned above the stove: the fog signal is louder than you think, and the cook is worse than you fear.',
  'She learned the routine within a month: wind the clockwork at dusk, polish the lens at dawn, and write down the weather whether or not anyone would read it.',
  'Winter came in October. The boat stopped for three weeks at a time, and the radio became the only voice that answered her.',
  'A fisherman she spoke to most nights told her that a lighthouse lens could throw a beam more than twenty miles on a clear night.',
  'In January a storm took the railing off the gallery. She tied herself to the door frame to relight the lamp and decided not to mention it in the log.',
  'By March she had read every book on the shelf twice and had started rating them by how well they would burn, though she never burned one.',
  'When the automatic lamp arrived the next summer, the engineers installed it in an afternoon and asked her whether she would miss the work.',
  'She said she would miss the weather. Nobody writes it down for a machine.',
  'On her last morning she polished the lens anyway, because a habit is just a promise you keep to yourself.',
]

export const CHAPTERS = [
  { title: 'The Light', startsAt: 0 },
  { title: 'Winter', startsAt: 5 },
  { title: 'Leaving', startsAt: 9 },
]

/** Where the reader is when each command is spoken: the end of chapter one. */
export const POSITION = 4

export const CONTEXT: AgentContext = {
  title: "The Keeper's Year",
  totalParagraphs: PARAGRAPHS.length,
  currentParagraph: POSITION,
  chapters: CHAPTERS,
  nearbyText: PARAGRAPHS.map((p, i) => `[${i}] ${p}`).join('\n'),
  rate: 1,
}
