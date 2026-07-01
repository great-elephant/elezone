import { useEffect, useState, useRef, useMemo } from 'react'
import { SavedItem, BOOKMARK_COLORS, Settings, StudyMode } from '../shared/types'

interface StudyUIProps {
  items: SavedItem[]
  mode: StudyMode
  settings: Settings | null
  onClose: () => void
}

// Reward micro-interactions for the "+N Sparks" moment: a springy pop for the
// text plus a short ember burst. Keyframes must live in a <style> tag.
const rewardStyles = `
  @keyframes cxt-study-spark {
    0%   { opacity: 0; transform: translate(-50%, 8px) scale(0.6); }
    35%  { opacity: 1; transform: translate(-50%, -2px) scale(1.18); }
    55%  { transform: translate(-50%, -6px) scale(0.95); }
    72%  { transform: translate(-50%, -10px) scale(1.03); }
    100% { opacity: 0; transform: translate(-50%, -48px) scale(1); }
  }
  @keyframes cxt-study-ember {
    0%   { opacity: 1; transform: translate(-50%, -50%) translate(0, 0) scale(1); }
    100% { opacity: 0; transform: translate(-50%, -50%) translate(var(--dx), var(--dy)) scale(0.3); }
  }
  @keyframes cxt-reward-fade { 0% { opacity: 0 } 20% { opacity: 1 } 100% { opacity: 0 } }
  .cxt-reward-text { animation: cxt-study-spark 1.2s cubic-bezier(0.22, 1, 0.36, 1) forwards; }
  .cxt-reward-ember { animation: cxt-study-ember 0.9s ease-out forwards; }
  @media (prefers-reduced-motion: reduce) {
    .cxt-reward-text { animation: cxt-reward-fade 1s ease-out forwards; }
    .cxt-reward-ember { display: none; }
  }
`

export default function StudyUI({ items, mode, settings, onClose }: StudyUIProps) {
  const [sessionQueue, setSessionQueue] = useState<SavedItem[]>([])
  const [sessionTotal, setSessionTotal] = useState(0)
  const [activeItem, setActiveItem] = useState<SavedItem | null>(null)
  const nextBtnRef = useRef<HTMLButtonElement>(null)

  const [showAnswer, setShowAnswer] = useState(false)
  const [showHint, setShowHint] = useState(false)
  const [verificationPassed, setVerificationPassed] = useState(false)
  const [userAnswer, setUserAnswer] = useState('')
  const [mcOptions, setMcOptions] = useState<string[]>([])
  const [verifyError, setVerifyError] = useState(false)
  const [wrongOptions, setWrongOptions] = useState<Set<string>>(new Set())
  const [sessionScore, setSessionScore] = useState({ correct: 0, giveUps: 0 })
  const [showSessionSummary, setShowSessionSummary] = useState(false)
  const [earnedSpark, setEarnedSpark] = useState(false)
  // Consecutive correct answers drive the combo escalation; rewardNonce reseeds
  // the ember burst so it regenerates only when a reward actually fires.
  const [combo, setCombo] = useState(0)
  const [maxCombo, setMaxCombo] = useState(0)
  const [rewardNonce, setRewardNonce] = useState(0)
  // A card answered wrong at least once does not extend the streak, even if the
  // user retries and gets it right.
  const [cardFailed, setCardFailed] = useState(false)
  const emberParticles = useMemo(() => {
    const n = 10
    const colors = ['#ffd93d', '#ffb36b', '#ff9d3d', '#ff6b3d', '#4ade80']
    return Array.from({ length: n }, (_, i) => {
      const angle = (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.6
      const dist = 26 + Math.random() * 26
      return {
        dx: `${Math.cos(angle) * dist}px`,
        dy: `${Math.sin(angle) * dist}px`,
        color: colors[i % colors.length],
        size: 4 + Math.round(Math.random() * 3),
      }
    })
  }, [rewardNonce])

  // Track the highest combo reached this session for the summary "Best streak".
  useEffect(() => {
    setMaxCombo(m => (combo > m ? combo : m))
  }, [combo])

  function initSession() {
    setSessionQueue(items)
    setSessionTotal(items.length)
    setActiveItem(items[0])
    setShowAnswer(false)
    setShowHint(!!settings?.showHintInitially)
    setVerificationPassed(mode === 'passive')
    setUserAnswer('')
    setVerifyError(false)
    setWrongOptions(new Set())
    setSessionScore({ correct: 0, giveUps: 0 })
    setShowSessionSummary(false)
    setEarnedSpark(false)
    setCombo(0)
    setMaxCombo(0)
    setCardFailed(false)
    if (mode === 'multiple_choice') generateMcOptions(items[0], items)
    if (mode === 'listening') {
      setTimeout(() => speakText((items[0].prefix || '') + items[0].text + (items[0].suffix || ''), items[0].sourceLang), 300)
    }
  }

  useEffect(() => {
    if (items.length > 0) {
      initSession()
    } else {
      setActiveItem(null)
      setShowSessionSummary(true)
    }
  }, [items, mode])

  useEffect(() => {
    const timer = setTimeout(() => {
      nextBtnRef.current?.focus()
    }, 150)
    return () => clearTimeout(timer)
  }, [verificationPassed, showAnswer, wrongOptions.size, activeItem, showSessionSummary])

  function speakText(text: string, lang?: string) {
    chrome.tts.stop()
    if (settings?.readAloud) {
      const r = settings.readAloud
      chrome.tts.speak(text, {
        pitch: r.pitch,
        rate: r.speed,
        lang,
        voiceName: (lang && r.languageVoices?.[lang]) || r.voice || undefined,
        volume: r.volume
      })
    } else {
      chrome.tts.speak(text, { lang })
    }
  }

  function generateMcOptions(item: SavedItem, allItems: SavedItem[]) {
    const otherItems = allItems.filter(i => i.id !== item.id && i.text)
    const shuffled = [...otherItems].sort(() => 0.5 - Math.random())
    const distractors = shuffled.slice(0, 3).map(i => i.text)
    const options = [item.text, ...distractors].sort(() => 0.5 - Math.random())
    setMcOptions(options)
  }

  function handleNext() {
    if (mode === 'passive' || earnedSpark) {
      chrome.runtime.sendMessage({ type: 'LOG_ACTIVITY', payload: 'review' }).catch(() => {})
    }
    setEarnedSpark(false)
    setSessionQueue(prev => {
      const nextQueue = prev.slice(1)
      if (nextQueue.length > 0) {
        setActiveItem(nextQueue[0])
        setShowAnswer(false)
        setShowHint(!!settings?.showHintInitially)
        setVerificationPassed(mode === 'passive')
        setUserAnswer('')
        setVerifyError(false)
        setCardFailed(false)
        setWrongOptions(new Set())
        if (mode === 'multiple_choice') generateMcOptions(nextQueue[0], items)
        if (mode === 'listening') {
          setTimeout(() => speakText((nextQueue[0].prefix || '') + nextQueue[0].text + (nextQueue[0].suffix || ''), nextQueue[0].sourceLang), 300)
        }
      } else {
        setActiveItem(null)
        setShowSessionSummary(true)
      }
      return nextQueue
    })
  }

  function handleVerify(value: string) {
    if (!activeItem) return
    if (value.trim().toLowerCase() === activeItem.text.trim().toLowerCase()) {
      setVerificationPassed(true)
      setShowAnswer(true)
      setSessionScore(prev => ({ ...prev, correct: prev.correct + 1 }))
      setEarnedSpark(true)
      setRewardNonce(n => n + 1)
      // Only a card answered right with no wrong attempt extends the streak.
      if (!cardFailed) setCombo(c => c + 1)
      setVerifyError(false)
      speakText(activeItem.text, activeItem.sourceLang)
    } else {
      setVerifyError(true)
      setCombo(0)
      setCardFailed(true)
      if (mode === 'multiple_choice') {
        setWrongOptions(prev => new Set(prev).add(value))
        speakText(activeItem.text, activeItem.sourceLang)
      }
    }
  }

  function handleGiveUp() {
    setVerificationPassed(true)
    setShowAnswer(true)
    setCombo(0)
    setSessionScore(prev => ({ ...prev, giveUps: prev.giveUps + 1 }))
    if (activeItem) {
      speakText(activeItem.text, activeItem.sourceLang)
    }
  }

  if (showSessionSummary) {
    const pointsPerReview = settings?.gamification?.pointsPerReview ?? 2
    const sparksEarned = (mode === 'passive' ? sessionTotal : sessionScore.correct) * pointsPerReview
    return (
      <SessionSummary
        correct={sessionScore.correct}
        total={sessionTotal}
        maxCombo={maxCombo}
        sparksEarned={sparksEarned}
        mode={mode}
        onClose={onClose}
        onRestart={() => { if (items.length > 0) initSession() }}
      />
    )
  }

  if (!activeItem) return null

  const isFlashcard = !!activeItem.translation

  const rewardPoints = settings?.gamification?.pointsPerReview ?? 2
  const rewardColor = combo >= 6 ? '#ff5a36' : combo >= 4 ? '#ff9d3d' : combo >= 2 ? '#facc15' : '#4ade80'
  const rewardSize = 20 + Math.min(Math.max(combo - 1, 0), 6) * 3

  return (
    <div style={styles.reviewContainer}>
      <div style={styles.headerRow}>
        <button style={{ ...styles.syncBtn, background: 'transparent', border: '1px solid #3a3a5a' }} onClick={onClose}>
          ← Back to Library
        </button>
      </div>

      <div style={styles.cardInfo}>
        Studying {isFlashcard ? 'Vocabulary' : 'Comprehension'}
        <span style={{ marginLeft: 12, fontSize: '0.9em', color: '#8888aa' }}>
          ({sessionTotal - sessionQueue.length + 1} / {sessionTotal})
        </span>
        <div
          style={{
            ...styles.colorDot,
            backgroundColor: BOOKMARK_COLORS[activeItem.color],
            display: 'inline-block',
            marginLeft: 8
          }}
        />
      </div>

      <div key={activeItem.id} style={{ ...styles.card, borderColor: BOOKMARK_COLORS[activeItem.color], position: 'relative' }}>
        {earnedSpark && (
          <>
            <style>{rewardStyles}</style>
            <div style={styles.rewardAnchor}>
              {emberParticles.map((p, i) => (
                <span
                  key={i}
                  className="cxt-reward-ember"
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    width: p.size,
                    height: p.size,
                    borderRadius: '50%',
                    background: p.color,
                    '--dx': p.dx,
                    '--dy': p.dy,
                  } as React.CSSProperties}
                />
              ))}
            </div>
            <div className="cxt-reward-text" style={{ ...styles.sparkReward, color: rewardColor, fontSize: rewardSize }}>
              +{rewardPoints} Sparks 🔥{combo >= 2 ? ` · 🔥×${combo}` : ''}
            </div>
          </>
        )}
        <div style={styles.cardFront}>
          {isFlashcard ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px', width: '100%' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
                <div style={styles.contextSentence}>
                  {activeItem.prefix || activeItem.suffix ? (
                    <>
                      {activeItem.prefix}
                      <span style={styles.clozeWord}>
                        {showAnswer ? activeItem.text : '[...]'}
                      </span>
                      {activeItem.suffix}
                    </>
                  ) : (
                    <div style={styles.hintPrompt}>
                      {showAnswer ? (
                        <span style={styles.clozeWord}>{activeItem.text}</span>
                      ) : (
                        <span style={{ color: '#8888aa', fontStyle: 'italic' }}>
                          What is the English word?
                        </span>
                      )}
                    </div>
                  )}
                </div>
                {(showAnswer || mode === 'listening') && (
                  <button
                    style={styles.speakerBtn}
                    onClick={() => speakText((activeItem.prefix || '') + activeItem.text + (activeItem.suffix || ''), activeItem.sourceLang)}
                    title="Read sentence aloud"
                  >
                    🔊
                  </button>
                )}
              </div>

              {!verificationPassed && (
                <div style={{ marginTop: '10px', width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
                  {(mode === 'typing' || mode === 'listening') && (
                    <div style={{ width: '80%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
                      <input
                        autoFocus
                        style={{ padding: '12px', fontSize: '18px', borderRadius: '8px', border: `2px solid ${verifyError ? '#ff6b6b' : '#3a3a5a'}`, background: '#111122', color: 'white', width: '100%', textAlign: 'center' }}
                        placeholder="Type the answer here..."
                        value={userAnswer}
                        onChange={(e) => {
                          setUserAnswer(e.target.value)
                          if (verifyError) setVerifyError(false)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            handleVerify(userAnswer)
                          }
                        }}
                      />
                      {verifyError && <span style={{ color: '#ff6b6b', fontSize: '14px' }}>Incorrect, try again!</span>}
                    </div>
                  )}



                  {mode === 'multiple_choice' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', width: '100%', alignItems: 'center' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', width: '100%' }}>
                        {mcOptions.map((opt, i) => {
                          const isCorrectAns = opt.trim().toLowerCase() === activeItem.text.trim().toLowerCase()
                          const hasFailed = wrongOptions.size > 0
                          const isClickedWrong = wrongOptions.has(opt)

                          let bg = '#2a2a4a'
                          if (hasFailed) {
                            if (isCorrectAns) bg = '#6bff9e'
                            else if (isClickedWrong) bg = '#ff6b6b'
                          }

                          return (
                            <button
                              key={i}
                              style={{
                                ...styles.showBtn,
                                background: bg,
                                color: (hasFailed && isCorrectAns) ? '#112211' : '#ffffff',
                                fontSize: '16px',
                                opacity: (hasFailed && !isCorrectAns && !isClickedWrong) ? 0.4 : 1,
                                cursor: hasFailed ? 'default' : 'pointer',
                                transition: 'all 0.2s ease',
                                fontWeight: hasFailed && isCorrectAns ? 'bold' : 'normal'
                              }}
                              onClick={() => !hasFailed && handleVerify(opt)}
                              disabled={hasFailed}
                            >
                              {opt}
                            </button>
                          )
                        })}
                      </div>
                      {wrongOptions.size > 0 && (
                        <button
                          ref={nextBtnRef}
                          style={{ ...styles.startBtn, marginTop: '8px', padding: '10px 24px', fontSize: '16px', width: 'auto' }}
                          onClick={() => {
                            setSessionScore(prev => ({ ...prev, giveUps: prev.giveUps + 1 }))
                            handleNext()
                          }}
                        >
                          Next
                        </button>
                      )}
                    </div>
                  )}

                  {mode !== 'multiple_choice' && !showHint && (
                    <button
                      style={{ ...styles.showBtn, padding: '8px 16px', fontSize: '14px', background: '#2a2a4a' }}
                      onClick={() => setShowHint(true)}
                    >
                      Show Hint
                    </button>
                  )}

                  {showHint && mode !== 'multiple_choice' && (
                    <div style={{ color: '#8888aa', fontStyle: 'italic', fontSize: '18px', textAlign: 'center' }}>
                      Hint: {mode === 'listening'
                        ? `Starts with "${activeItem.text[0]}..."`
                        : activeItem.translation}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div style={styles.contextSentence}>
              {activeItem.text}
            </div>
          )}
        </div>

        {showAnswer && (
          <div style={styles.cardBack}>
            {isFlashcard ? (
              <>
                <div style={styles.targetWord}>
                  {activeItem.text}
                  <button
                    style={styles.speakerBtn}
                    onClick={() => speakText(activeItem.text, activeItem.sourceLang)}
                    title="Read word aloud"
                  >
                    🔊
                  </button>
                  {activeItem.phonetics && (
                    <span style={styles.phonetics}>{activeItem.phonetics}</span>
                  )}
                </div>
                <div style={styles.translation}>{activeItem.translation}</div>
              </>
            ) : (
              <div style={styles.targetWord}>Did you understand this paragraph?</div>
            )}
          </div>
        )}
      </div>

      {!verificationPassed ? (
        <div style={{ display: 'flex', gap: '12px', width: '100%' }}>
          <button style={{ ...styles.showBtn, flex: 1, background: 'transparent', border: '1px solid #ffb36b', color: '#ffb36b' }} onClick={handleGiveUp}>
            Give Up
          </button>
          {(mode === 'typing' || mode === 'listening') && (
            <button style={{ ...styles.showBtn, flex: 1, background: '#4a5a9a' }} onClick={() => handleVerify(userAnswer)}>
              Verify
            </button>
          )}
        </div>
      ) : !showAnswer && mode === 'passive' ? (
        <button ref={nextBtnRef} style={styles.showBtn} onClick={() => {
          setShowAnswer(true)
          if (activeItem.text) speakText(activeItem.text, activeItem.sourceLang)
        }}>
          Show Answer
        </button>
      ) : (
        <button
          ref={nextBtnRef}
          style={{ ...styles.startBtn, background: '#6bcfff', color: '#111122' }}
          onClick={handleNext}
        >
          Next
        </button>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  dashboard: {
    maxWidth: 600,
    margin: '0 auto',
    padding: '20px 0'
  },
  headerRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 32
  },
  syncBtn: {
    background: '#2a2a4a',
    color: '#e0e0ff',
    border: 'none',
    padding: '8px 16px',
    borderRadius: 6,
    cursor: 'pointer'
  },
  startBtn: {
    width: '100%',
    padding: 16,
    background: '#4a5a9a',
    color: 'white',
    fontSize: 18,
    fontWeight: 'bold',
    border: 'none',
    borderRadius: 12,
    cursor: 'pointer'
  },
  allDone: {
    textAlign: 'center',
    padding: 32,
    background: '#1a1a2e',
    borderRadius: 12,
    color: '#8888aa'
  },
  reviewContainer: {
    maxWidth: 600,
    margin: '0 auto',
    height: 'calc(100vh - 116px)',
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    padding: '8px 0'
  },
  cardInfo: {
    textAlign: 'center',
    color: '#8888aa',
    fontSize: 14,
    fontWeight: 'bold'
  },
  colorDot: {
    width: 10,
    height: 10,
    borderRadius: '50%'
  },
  card: {
    background: '#1a1a2e',
    borderWidth: 2,
    borderStyle: 'solid',
    borderRadius: 16,
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden'
  },
  cardFront: {
    padding: '18px 24px',
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
  },
  contextSentence: {
    fontSize: 20,
    lineHeight: 1.6,
    color: '#e0e0e0',
    textAlign: 'center'
  },
  clozeWord: {
    fontWeight: 'bold',
    color: '#6bcfff',
    borderBottom: '2px dashed #6bcfff',
    margin: '0 6px'
  },
  hintPrompt: {
    fontSize: 24,
    color: '#ffffff',
    textAlign: 'center'
  },
  cardBack: {
    padding: '14px 24px',
    borderTop: '1px solid #2a2a4a',
    background: '#111122',
    textAlign: 'center'
  },
  targetWord: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#ffffff',
    marginBottom: 8,
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'center',
    gap: 8
  },
  phonetics: {
    fontSize: 16,
    fontWeight: 'normal',
    color: '#8888aa'
  },
  translation: {
    fontSize: 18,
    color: '#8888aa'
  },
  showBtn: {
    padding: 16,
    background: '#3a3a5a',
    color: 'white',
    fontSize: 16,
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer'
  },
  speakerBtn: {
    background: 'none',
    border: 'none',
    fontSize: '20px',
    cursor: 'pointer',
    padding: '4px',
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'transform 0.1s'
  },
  sparkReward: {
    position: 'absolute',
    top: 16,
    left: '50%',
    transform: 'translateX(-50%)',
    color: '#4ade80',
    fontWeight: 'bold',
    fontSize: 20,
    pointerEvents: 'none',
    textShadow: '0 1px 6px rgba(0,0,0,0.6)',
    zIndex: 2,
  },
  rewardAnchor: {
    position: 'absolute',
    top: 30,
    left: '50%',
    width: 0,
    height: 0,
    zIndex: 2,
    pointerEvents: 'none',
  }
}

const sessionSummaryStyles = `
  @keyframes cxt-confetti-fall {
    0%   { opacity: 1; transform: translate(0, 0) rotate(0deg); }
    100% { opacity: 0; transform: translate(var(--drift), 460px) rotate(var(--rot)); }
  }
  @keyframes cxt-rank-pop {
    0%   { transform: scale(0.3); opacity: 0; }
    60%  { transform: scale(1.15); opacity: 1; }
    100% { transform: scale(1); opacity: 1; }
  }
  .cxt-confetti { animation: cxt-confetti-fall var(--dur) ease-in var(--delay) forwards; }
  .cxt-rank-pop { display: inline-block; animation: cxt-rank-pop 0.6s cubic-bezier(0.22, 1, 0.36, 1) forwards; }
  @media (prefers-reduced-motion: reduce) {
    .cxt-confetti { display: none; }
    .cxt-rank-pop { animation: none; }
  }
`

function Pill({ value, label, color }: { value: string; label: string; color: string }) {
  return (
    <div style={{ background: '#1a1a2e', border: '1px solid #2a2a4a', borderRadius: 12, padding: '10px 16px', minWidth: 88 }}>
      <div style={{ fontSize: 20, fontWeight: 'bold', color }}>{value}</div>
      <div style={{ fontSize: 12, color: '#8888aa', marginTop: 2 }}>{label}</div>
    </div>
  )
}

function SessionSummary({ correct, total, maxCombo, sparksEarned, mode, onClose, onRestart }: {
  correct: number
  total: number
  maxCombo: number
  sparksEarned: number
  mode: StudyMode
  onClose: () => void
  onRestart: () => void
}) {
  const isPassive = mode === 'passive'
  const accuracy = total > 0 ? Math.round((correct / total) * 100) : 0
  const rank = isPassive
    ? { emoji: '🎉', title: 'Session complete!', color: '#6bcfff' }
    : accuracy >= 100 ? { emoji: '🏆', title: 'Perfect!', color: '#ffd93d' }
      : accuracy >= 80 ? { emoji: '🎉', title: 'Great job!', color: '#4ade80' }
        : accuracy >= 50 ? { emoji: '💪', title: 'Nice work!', color: '#6bcfff' }
          : { emoji: '🌱', title: 'Keep practicing!', color: '#ffb36b' }

  const [ringPct, setRingPct] = useState(0)
  useEffect(() => {
    const id = setTimeout(() => setRingPct(accuracy), 120)
    return () => clearTimeout(id)
  }, [accuracy])

  const confetti = useMemo(() => {
    const colors = ['#ffd93d', '#ff6bc0', '#6bcfff', '#4ade80', '#ffb36b', '#c06bff']
    return Array.from({ length: 40 }, (_, i) => ({
      left: Math.random() * 100,
      delay: Math.random() * 0.4,
      dur: 1.6 + Math.random() * 1.4,
      color: colors[i % colors.length],
      size: 5 + Math.round(Math.random() * 5),
      rot: Math.round(Math.random() * 540),
      drift: `${(Math.random() - 0.5) * 140}px`,
    }))
  }, [])

  const closeBtnRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const t = setTimeout(() => closeBtnRef.current?.focus(), 150)
    return () => clearTimeout(t)
  }, [])

  const R = 58
  const SW = 12
  const CIRC = 2 * Math.PI * R
  const dashoffset = CIRC - (ringPct / 100) * CIRC

  return (
    <div style={{ position: 'relative', maxWidth: 600, margin: '0 auto', padding: '8px 0', overflow: 'hidden', minHeight: 'calc(100vh - 116px)', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
      <style>{sessionSummaryStyles}</style>

      <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', zIndex: 3 }}>
        {confetti.map((c, i) => (
          <span
            key={i}
            className="cxt-confetti"
            style={{
              position: 'absolute',
              top: -14,
              left: `${c.left}%`,
              width: c.size,
              height: c.size * 0.5,
              background: c.color,
              borderRadius: 1,
              '--dur': `${c.dur}s`,
              '--delay': `${c.delay}s`,
              '--rot': `${c.rot}deg`,
              '--drift': c.drift,
            } as React.CSSProperties}
          />
        ))}
      </div>

      <div style={{
        background: 'linear-gradient(135deg, #1e1e32 0%, #111122 100%)',
        border: '1px solid #3a3a6a',
        borderRadius: 20,
        padding: '24px 24px',
        boxShadow: '0 12px 40px rgba(0,0,0,0.4)',
        textAlign: 'center',
        position: 'relative',
        zIndex: 2,
      }}>
        <div className="cxt-rank-pop" style={{ fontSize: 46, filter: `drop-shadow(0 0 14px ${rank.color}66)` }}>
          {rank.emoji}
        </div>
        <div style={{ fontSize: 23, fontWeight: 'bold', color: rank.color, marginTop: 4 }}>{rank.title}</div>
        <div style={{ color: '#8888aa', marginTop: 6, fontSize: 14 }}>
          {isPassive ? `Reviewed ${total} cards` : `You completed ${total} cards`}
        </div>

        {!isPassive && (
          <div style={{ position: 'relative', width: 148, height: 148, margin: '14px auto 4px' }}>
            <svg width="148" height="148" style={{ transform: 'rotate(-90deg)' }}>
              <circle cx="74" cy="74" r={R} stroke="#161b22" strokeWidth={SW} fill="none" />
              <circle
                cx="74" cy="74" r={R} stroke={rank.color} strokeWidth={SW} fill="none"
                strokeDasharray={CIRC} strokeDashoffset={dashoffset} strokeLinecap="round"
                style={{ transition: 'stroke-dashoffset 1s cubic-bezier(0.22, 1, 0.36, 1)' }}
              />
            </svg>
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ fontSize: 34, fontWeight: 'bold', color: '#fff' }}>{accuracy}%</div>
              <div style={{ fontSize: 12, color: '#8888aa' }}>{correct}/{total}</div>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'center', gap: 12, flexWrap: 'wrap', marginTop: isPassive ? 20 : 6, marginBottom: 18 }}>
          {!isPassive && <Pill value={`${correct}`} label="Correct" color="#6bff9e" />}
          {!isPassive && <Pill value={`🔥×${maxCombo}`} label="Best streak" color="#ffb36b" />}
          <Pill value={`+${sparksEarned} 🔥`} label="Sparks earned" color="#ffd93d" />
        </div>

        <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
          <button
            onClick={onRestart}
            style={{ background: 'transparent', color: '#8888cc', border: '1px solid #3a3a5a', borderRadius: 10, padding: '12px 24px', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}
          >
            Study again
          </button>
          <button
            ref={closeBtnRef}
            onClick={onClose}
            style={{ background: '#4a5a9a', color: '#fff', border: 'none', borderRadius: 10, padding: '12px 24px', fontSize: 15, fontWeight: 'bold', cursor: 'pointer' }}
          >
            Back to Library
          </button>
        </div>
      </div>
    </div>
  )
}
