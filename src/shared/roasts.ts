export type RoastLevel = 1 | 2 | 3

export const ROASTS_LEVEL_1 = [
  "🥺 Hello? Your vocabulary is crying, waiting for you to review.",
  "⏰ It only takes 5 minutes. Go study before you forget everything.",
  "🤨 Seems like you're being lazy, aren't you? Come back and review a bit.",
  "🌱 Don't let your new words grow moss, go water your brain.",
  "🙄 Some words are due. You're not going to ignore them, are you?"
]

export const ROASTS_LEVEL_2 = [
  "🫠 Your brain has already forgotten quite a few words, and it seems to have forgotten how to study too.",
  "📉 With this level of laziness, when will you ever not need subtitles?",
  "🗑️ Are you waiting for your vocabulary to completely vanish before studying?",
  "🤡 I bet you're spending time scrolling TikTok instead of studying.",
  "🪫 Hello? Anybody home? Your brain is on strike due to a lack of new words."
]

export const ROASTS_LEVEL_3 = [
  "🔥 Red alert: Your laziness has reached the supreme level.",
  "💣 Are you going to study English or should I just delete this app to free up space?",
  "💀 With discipline this poor, your dream of speaking fluent English is still far away, buddy.",
  "🤦‍♂️ I'm seriously concerned about your academic career right now.",
  "😱 Oh my goodness, the vocabulary is evaporating from your brain! Study right now!"
]

export function getRandomRoast(level: RoastLevel): string {
  const roasts = level === 1 ? ROASTS_LEVEL_1 : level === 2 ? ROASTS_LEVEL_2 : ROASTS_LEVEL_3
  const randomIndex = Math.floor(Math.random() * roasts.length)
  return roasts[randomIndex]
}
