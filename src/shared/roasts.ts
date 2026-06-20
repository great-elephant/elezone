export type RoastLevel = 1 | 2 | 3

export const ROASTS_LEVEL_1 = [
  "🥺 Alo, từ vựng đang khóc chờ bạn ôn kìa.",
  "⏰ Chỉ 5 phút thôi mà, vào học đi kẻo quên sạch.",
  "🤨 Hình như bạn đang lười đúng không? Quay lại ôn tập xíu đi.",
  "🌱 Đừng để từ mới mọc rêu, vào tưới nước cho não đi nào.",
  "🙄 Có vài từ đang đến hạn, bạn không định bơ chúng luôn chứ?"
]

export const ROASTS_LEVEL_2 = [
  "🫠 Não bạn đã quên mất kha khá từ rồi đấy, và có vẻ nó cũng quên luôn cách học.",
  "📉 Lười thế này thì bao giờ mới không cần dùng Vietsub?",
  "🗑️ Chắc bạn định chờ đến khi từ vựng bay màu hết mới vào học?",
  "🤡 Tôi cá là bạn đang dành thời gian lướt TikTok thay vì học ở đây.",
  "🪫 Hello? Anybody home? Não bạn đang đình công vì thiếu từ mới kìa."
]

export const ROASTS_LEVEL_3 = [
  "🔥 Báo động đỏ: Mức độ lười biếng của bạn đã đạt cảnh giới tối cao.",
  "💣 Bạn có định học tiếng Anh nữa không hay để tôi xóa app luôn cho nhẹ máy?",
  "💀 Kỷ luật kém thế này thì giấc mơ bắn tiếng Anh như gió còn xa lắm bạn êi.",
  "🤦‍♂️ Tôi thực sự quan ngại về sự nghiệp học hành của bạn lúc này.",
  "😱 Trời đất ơi, từ vựng đang thi nhau bốc hơi khỏi não bạn kìa, học ngay đi!"
]

export function getRandomRoast(level: RoastLevel): string {
  const roasts = level === 1 ? ROASTS_LEVEL_1 : level === 2 ? ROASTS_LEVEL_2 : ROASTS_LEVEL_3
  const randomIndex = Math.floor(Math.random() * roasts.length)
  return roasts[randomIndex]
}
