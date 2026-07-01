// Roast intensity controls how harsh the "tough love" / slacking messages are.
//   off     – no roasting at all (banner + notifications fully suppressed)
//   gentle  – soft, encouraging nudges
//   playful – cheeky teasing (friendly default)
//   savage  – over-the-top, dramatic tough love
export type RoastIntensity = 'off' | 'gentle' | 'playful' | 'savage'

export const DEFAULT_ROAST_INTENSITY: RoastIntensity = 'playful'

// Legacy severity level still used internally by the background to gauge how far
// behind the user is. It now maps onto intensity pools rather than fixed strings.
export type RoastLevel = 1 | 2 | 3

// Each intensity has its own pool of messages (English only).
const POOLS: Record<Exclude<RoastIntensity, 'off'>, string[]> = {
  gentle: [
    '🥺 Hello? Your vocabulary is waiting for a quick review.',
    '⏰ It only takes 5 minutes. A little review keeps it fresh.',
    '🌱 Give your new words a little water before they fade.',
    '🙂 A few cards are due. Want to knock them out?',
    '📗 Small daily reps beat cramming. Shall we do a set?',
  ],
  playful: [
    '🫠 Your brain has quietly forgotten a few words. Time to jog its memory.',
    '📉 At this pace, the subtitles are getting a little too comfortable.',
    '🤔 Waiting for the words to review themselves? Bold strategy.',
    '🤡 I bet a certain feed is winning against your flashcards today.',
    '🪫 Hello? Anybody home? Your brain is on a snack break from new words.',
  ],
  savage: [
    '🔥 Red alert: the slacking has reached legendary levels.',
    '💣 Are we studying English, or should I make room on your disk?',
    '💀 Fluent English is still a long way off at this discipline, buddy.',
    '🤦 Honestly, I am starting to worry about the study plan here.',
    '😱 The vocabulary is evaporating from your brain. Study, right now!',
  ],
}

function normalizeIntensity(intensity: RoastIntensity | undefined): RoastIntensity {
  return intensity ?? DEFAULT_ROAST_INTENSITY
}

// Pick a random roast for the given intensity. Returns null when roasting is
// off (or resolves to off), so callers can suppress the banner entirely.
export function getRandomRoast(intensity: RoastIntensity | undefined): string | null {
  const eff = normalizeIntensity(intensity)
  if (eff === 'off') return null
  const pool = POOLS[eff]
  return pool[Math.floor(Math.random() * pool.length)]
}
