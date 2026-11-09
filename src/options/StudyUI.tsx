import { useEffect, useState, useRef, useMemo } from 'react'
import { SavedItem, Settings, StudyMode, colorHex } from '../shared/types'
import { speak } from '../shared/speak'
import { speakFailureNotice } from '../shared/speakResult'
import { STUDY_DARK, type StudyTheme } from '../shared/studyTheme'
import { updateFsrsMetrics, previewFsrsDue, Rating, type Grade } from '../shared/library'

interface StudyUIProps {
  items: SavedItem[]
  mode: StudyMode
  settings: Settings | null
  onClose: () => void
  // Space (px) the host page reserves around the study area; the dashboard's
  // header takes 116, a side panel with its own slim header takes less.
  viewportOffset?: number
  // Palette to use instead of the built-in dark colors.
  theme?: StudyTheme
  // Narrow-panel layout: one-row header, tighter card, content-sized height.
  compact?: boolean
  // Text of the button that leaves the session.
  backLabel?: string
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

export default function StudyUI({ items, mode, settings, onClose, viewportOffset = 116, theme, compact = false, backLabel = '← Back to Library' }: StudyUIProps) {
  const t = theme ?? STUDY_DARK
  const styles = useMemo(() => buildStyles(t, compact), [t, compact])
  const [sessionQueue, setSessionQueue] = useState<SavedItem[]>([])
  const [sessionTotal, setSessionTotal] = useState(0)
  const [activeItem, setActiveItem] = useState<SavedItem | null>(null)
  const nextBtnRef = useRef<HTMLButtonElement>(null)
  // Guards against double-click on "Next": without it two rapid calls could
  // both read the same activeItem, double-submit SRS updates, and drop a
  // card from the queue (slice(1) applied twice).
  const isAdvancingRef = useRef(false)

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

  // Non-committing "what would each grade schedule this to" preview, shown as
  // a small "in 3d" hint under the Again/Hard/Good/Easy buttons — the same
  // reassurance Anki-style apps give that the buttons actually drive the
  // schedule, not just a cosmetic "how did that feel" prompt.
  const gradePreview = useMemo(
    () => (activeItem ? previewFsrsDue(activeItem) : null),
    [activeItem]
  )

  // Track the highest combo reached this session for the summary "Best streak".
  useEffect(() => {
    setMaxCombo(m => (combo > m ? combo : m))
  }, [combo])

  function initSession(sourceItems: SavedItem[] = items) {
    setSessionQueue(sourceItems)
    setSessionTotal(sourceItems.length)
    setActiveItem(sourceItems[0])
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
    if (mode === 'multiple_choice') generateMcOptions(sourceItems[0], sourceItems)
    if (mode === 'listening') {
      setTimeout(() => speakText((sourceItems[0].prefix || '') + sourceItems[0].text + (sourceItems[0].suffix || ''), sourceItems[0].sourceLang), 300)
    }
  }

  // "Study again" must not replay the SRS baseline captured when the session
  // first mounted: every card answered in the session just finished has
  // already been persisted to storage via UPDATE_ITEM, so re-using the stale
  // `items` prop would re-run updateSrsMetrics from the pre-session values
  // and regress interval/repetitions instead of building on them. Re-fetch
  // the latest copies from storage (same ids as this session) before restarting.
  function handleRestart() {
    if (items.length === 0) return
    const ids = new Set(items.map(i => i.id))
    chrome.runtime.sendMessage({ type: 'GET_ITEMS' }, (list: SavedItem[]) => {
      if (chrome.runtime.lastError || !list) {
        initSession()
        return
      }
      const fresh = list.filter(i => ids.has(i.id))
      initSession(fresh.length > 0 ? fresh : items)
    })
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

  // Compact multiple choice: keys 1-4 pick the matching option.
  useEffect(() => {
    if (!compact || mode !== 'multiple_choice' || verificationPassed || wrongOptions.size > 0) return
    const onKey = (e: KeyboardEvent) => {
      const n = Number(e.key)
      if (e.metaKey || e.ctrlKey || e.altKey || !Number.isInteger(n) || n < 1 || n > mcOptions.length) return
      handleVerify(mcOptions[n - 1])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // "in 10m" / "in 3d" / "in 2mo" — short relative label for a grade preview.
  function formatDueIn(due: Date): string {
    const ms = due.getTime() - Date.now()
    const minutes = Math.round(ms / 60000)
    if (minutes < 60) return `${Math.max(1, minutes)}m`
    const hours = Math.round(minutes / 60)
    if (hours < 24) return `${hours}h`
    const days = Math.round(hours / 24)
    if (days < 30) return `${days}d`
    const months = Math.round(days / 30)
    if (months < 12) return `${months}mo`
    return `${Math.round(months / 12)}y`
  }

  const [speakNotice, setSpeakNotice] = useState<string | null>(null)

  function speakText(text: string, lang?: string) {
    // Fire and forget: nothing here shows a "speaking" indicator, and the
    // background interrupts whatever was mid-utterance anyway.
    setSpeakNotice(null)
    void speak(text, { lang }).then(res => {
      if (!res.ok) setSpeakNotice(speakFailureNotice(res.error))
    })
  }

  function generateMcOptions(item: SavedItem, allItems: SavedItem[]) {
    const shuffled = [...allItems].sort(() => 0.5 - Math.random())
    // De-dupe by text (case-insensitive): two different SavedItems can share
    // the same word (e.g. bookmarked from two different pages), which would
    // otherwise put the same label on two buttons — one "correct", one "wrong".
    const seenTexts = new Set([item.text.trim().toLowerCase()])
    const distractors: string[] = []
    for (const i of shuffled) {
      if (i.id === item.id || !i.text) continue
      const key = i.text.trim().toLowerCase()
      if (seenTexts.has(key)) continue
      seenTexts.add(key)
      distractors.push(i.text)
      if (distractors.length === 3) break
    }
    const options = [item.text, ...distractors].sort(() => 0.5 - Math.random())
    setMcOptions(options)
  }

  // `grade` is explicit for the 4 Again/Hard/Good/Easy buttons at the bottom
  // of a revealed card. Passed as undefined only from the one remaining path
  // that never reveals the full 4-way choice — multiple choice's own inline
  // "Next" after a wrong pick (line ~424) — which keeps the old binary
  // inference (passive/no-fail → Good, otherwise → Again) since the user
  // already told us the outcome by picking wrong; asking again would be
  // redundant.
  function handleNext(grade?: Grade) {
    if (isAdvancingRef.current) return
    isAdvancingRef.current = true
    setSpeakNotice(null)
    if (mode === 'passive' || earnedSpark) {
      chrome.runtime.sendMessage({ type: 'LOG_ACTIVITY', payload: 'review' }).catch(() => {})
    }
    if (activeItem) {
      const passed = mode === 'passive' || !cardFailed
      const finalGrade = grade ?? (passed ? Rating.Good : Rating.Again)
      const updated = updateFsrsMetrics(activeItem, finalGrade)
      chrome.runtime.sendMessage({ type: 'UPDATE_ITEM', payload: updated }).catch(() => {})
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
      isAdvancingRef.current = false
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
    setCardFailed(true)
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
        viewportOffset={viewportOffset}
        theme={t}
        compact={compact}
        closeLabel={backLabel.replace(/^←\s*/, '')}
        correct={sessionScore.correct}
        total={sessionTotal}
        maxCombo={maxCombo}
        sparksEarned={sparksEarned}
        mode={mode}
        onClose={onClose}
        onRestart={handleRestart}
      />
    )
  }

  if (!activeItem) return null

  const isFlashcard = !!activeItem.translation

  const rewardPoints = settings?.gamification?.pointsPerReview ?? 2
  const rewardColor = combo >= 6 ? t.reward[3] : combo >= 4 ? t.reward[2] : combo >= 2 ? t.reward[1] : t.reward[0]
  const rewardSize = 20 + Math.min(Math.max(combo - 1, 0), 6) * 3

  const sentenceLen = ((activeItem.prefix || '') + activeItem.text + (activeItem.suffix || '')).length
  const promptSize = sentenceLen <= 60 ? 20 : sentenceLen <= 140 ? 17 : 15

  const answerControls = verificationPassed ? null : (
                <div style={{ marginTop: compact ? 0 : '10px', width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: compact ? '8px' : '16px' }}>
                  {(mode === 'typing' || mode === 'listening') && (
                    <div style={{ width: compact ? '100%' : '80%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
                      <input
                        autoFocus
                        style={{ padding: compact ? '9px' : '12px', fontSize: compact ? '16px' : '18px', borderRadius: '8px', border: `2px solid ${verifyError ? t.error : t.border}`, background: t.inset, color: t.strong, width: '100%', textAlign: 'center' }}
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
                      {verifyError && <span style={{ color: t.error, fontSize: '14px' }}>Incorrect, try again!</span>}
                    </div>
                  )}



                  {mode === 'multiple_choice' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? '10px' : '16px', width: '100%', alignItems: 'center' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: compact ? '1fr' : '1fr 1fr', gap: compact ? '6px' : '12px', width: '100%' }}>
                        {mcOptions.map((opt, i) => {
                          const isCorrectAns = opt.trim().toLowerCase() === activeItem.text.trim().toLowerCase()
                          const hasFailed = wrongOptions.size > 0
                          const isClickedWrong = wrongOptions.has(opt)

                          let bg = t.choiceBg
                          if (hasFailed) {
                            if (isCorrectAns) bg = t.correctBg
                            else if (isClickedWrong) bg = t.wrongBg
                          }

                          return (
                            <button
                              key={i}
                              style={{
                                ...styles.showBtn,
                                background: bg,
                                color: (hasFailed && isCorrectAns) ? t.correctText : (hasFailed && isClickedWrong) ? t.wrongText : t.choiceText,
                                fontSize: compact ? '15px' : '16px',
                                ...(compact ? { padding: '8px 10px', minHeight: 44, alignItems: 'center', overflowWrap: 'anywhere' as const, textAlign: 'left' as const, display: 'flex', gap: 10 } : {}),
                                opacity: (hasFailed && !isCorrectAns && !isClickedWrong) ? 0.4 : 1,
                                cursor: hasFailed ? 'default' : 'pointer',
                                transition: 'all 0.2s ease',
                                fontWeight: hasFailed && isCorrectAns ? 'bold' : 'normal'
                              }}
                              onClick={() => !hasFailed && handleVerify(opt)}
                              disabled={hasFailed}
                            >
                              {compact && <span style={{ opacity: 0.6, fontSize: 13, flex: 'none' }}>{i + 1}</span>}
                              <span>{opt}</span>
                            </button>
                          )
                        })}
                      </div>
                      {wrongOptions.size > 0 && (
                        <button
                          ref={nextBtnRef}
                          style={{ ...styles.startBtn, marginTop: compact ? 0 : '8px', background: t.primary, color: t.primaryText, padding: '10px 24px', fontSize: '16px', width: compact ? '100%' : 'auto' }}
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
                      style={compact ? { background: 'none', border: 'none', color: t.muted, fontSize: 13, padding: '2px 8px', cursor: 'pointer', textDecoration: 'underline' } : { ...styles.showBtn, padding: '8px 16px', fontSize: '14px', background: t.choiceBg, color: t.choiceText }}
                      onClick={() => setShowHint(true)}
                    >
                      Show Hint
                    </button>
                  )}

                  {showHint && mode !== 'multiple_choice' && (
                    <div style={{ color: t.muted, fontStyle: 'italic', fontSize: compact ? '14px' : '18px', textAlign: 'center' }}>
                      Hint: {mode === 'listening'
                        ? `Starts with "${activeItem.text[0]}..."`
                        : activeItem.translation}
                    </div>
                  )}
                </div>
  )

  return (
    <div style={{ ...styles.reviewContainer, height: `calc(100vh - ${viewportOffset}px)` }}>
      {compact ? (
        <div style={{ flex: 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <button style={{ background: 'none', border: 'none', padding: '4px 0', color: t.link, fontSize: 13, cursor: 'pointer' }} onClick={onClose}>
              {backLabel}
            </button>
            <span style={{ fontSize: 12, color: t.muted }}>{sessionTotal - sessionQueue.length + 1}/{sessionTotal}</span>
          </div>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={sessionTotal}
            aria-valuenow={sessionTotal - sessionQueue.length}
            style={{ height: 3, borderRadius: 2, background: t.border, overflow: 'hidden' }}
          >
            <div style={{ height: '100%', width: `${((sessionTotal - sessionQueue.length) / Math.max(sessionTotal, 1)) * 100}%`, background: t.cloze, transition: 'width 0.3s ease' }} />
          </div>
        </div>
      ) : (
        <>
          <div style={styles.headerRow}>
            <button style={{ ...styles.syncBtn, background: 'transparent', border: `1px solid ${t.border}` }} onClick={onClose}>
              {backLabel}
            </button>
          </div>

          <div style={styles.cardInfo}>
            Studying {isFlashcard ? 'Vocabulary' : 'Comprehension'}
            <span style={{ marginLeft: 12, fontSize: '0.9em', color: t.muted }}>
              ({sessionTotal - sessionQueue.length + 1} / {sessionTotal})
            </span>
            <div
              style={{
                ...styles.colorDot,
                backgroundColor: colorHex(activeItem.color),
                display: 'inline-block',
                marginLeft: 8
              }}
            />
          </div>
        </>
      )}

      <div key={activeItem.id} style={{ ...styles.card, ...(compact ? { borderColor: t.borderSoft } :{ borderColor: colorHex(activeItem.color) }), position: 'relative' }}>
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
        {speakNotice && (
          <div role="alert" style={{ color: t.error, fontSize: compact ? 12 : 13, lineHeight: 1.4, textAlign: 'center', maxWidth: '100%', overflowWrap: 'anywhere', padding: '8px 12px 0' }}>
            {speakNotice}
          </div>
        )}
        <div style={styles.cardFront}>
          {isFlashcard ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: compact ? '10px' : '20px', width: '100%', ...(compact ? { margin: 'auto 0' } : {}) }}>
              {compact && mode === 'listening' && !showAnswer && (
                <button
                  style={{ width: 46, height: 46, flex: 'none', borderRadius: '50%', border: `2px solid ${t.cloze}`, background: t.inset, fontSize: 22, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  onClick={() => speakText((activeItem.prefix || '') + activeItem.text + (activeItem.suffix || ''), activeItem.sourceLang)}
                  title="Play again"
                  aria-label="Play again"
                >
                  🔊
                </button>
              )}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
                <div style={compact ? { ...styles.contextSentence, fontSize: promptSize } : styles.contextSentence}>
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
                        <span style={{ color: t.muted, fontStyle: 'italic' }}>
                          What is the English word?
                        </span>
                      )}
                    </div>
                  )}
                </div>
                {!compact && (showAnswer || mode === 'listening') && (
                  <button
                    style={styles.speakerBtn}
                    onClick={() => speakText((activeItem.prefix || '') + activeItem.text + (activeItem.suffix || ''), activeItem.sourceLang)}
                    title="Read sentence aloud"
                  >
                    🔊
                  </button>
                )}
              </div>

              {!compact && answerControls}
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

      <div style={compact ? { flex: 'none', minHeight: 64, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' } : { display: 'contents' }}>
      {compact && answerControls && <div style={{ marginBottom: 6 }}>{answerControls}</div>}
      {!verificationPassed ? (
        compact && mode === 'multiple_choice' && wrongOptions.size > 0 ? null :
        <div style={{ display: 'flex', gap: '12px', width: '100%', ...(compact ? { alignItems: 'center' } : {}) }}>
          <button style={compact ? { background: 'none', border: 'none', color: t.muted, fontSize: 14, padding: '12px 8px', cursor: 'pointer', textDecoration: 'underline', ...(mode === 'typing' || mode === 'listening' ? {} : { flex: 1 }) } : { ...styles.showBtn, flex: 1, background: 'transparent', border: `1px solid ${t.warn}`, color: t.warn }} onClick={handleGiveUp}>
            Give Up
          </button>
          {(mode === 'typing' || mode === 'listening') && (
            <button style={{ ...styles.showBtn, flex: 1, background: t.primary, color: t.primaryText, ...(compact ? { fontWeight: 600 } : {}) }} onClick={() => handleVerify(userAnswer)}>
              Verify
            </button>
          )}
        </div>
      ) : !showAnswer && mode === 'passive' ? (
        <button ref={nextBtnRef} style={compact ? { ...styles.showBtn, background: t.primary, color: t.primaryText, fontWeight: 600 } : styles.showBtn} onClick={() => {
          setShowAnswer(true)
          if (activeItem.text) speakText(activeItem.text, activeItem.sourceLang)
        }}>
          Show Answer
        </button>
      ) : (
        <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
          {([
            { grade: Rating.Again as Grade, label: 'Again', bg: t.grade.again[0], color: t.grade.again[1] },
            { grade: Rating.Hard as Grade, label: 'Hard', bg: t.grade.hard[0], color: t.grade.hard[1] },
            { grade: Rating.Good as Grade, label: 'Good', bg: t.grade.good[0], color: t.grade.good[1] },
            { grade: Rating.Easy as Grade, label: 'Easy', bg: t.grade.easy[0], color: t.grade.easy[1] },
          ] as const).map(({ grade, label, bg, color }) => (
            <button
              key={label}
              ref={grade === Rating.Good ? nextBtnRef : undefined}
              style={{ ...styles.gradeBtn, background: bg, color }}
              onClick={() => handleNext(grade)}
            >
              <span>{label}</span>
              {gradePreview && <span style={styles.gradeBtnHint}>{formatDueIn(gradePreview[grade])}</span>}
            </button>
          ))}
        </div>
      )}
      </div>
    </div>
  )
}

function buildStyles(t: StudyTheme, compact: boolean): Record<string, React.CSSProperties> {
  return {
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
    background: t.choiceBg,
    color: t.choiceText,
    border: 'none',
    padding: '8px 16px',
    borderRadius: 6,
    cursor: 'pointer'
  },
  startBtn: {
    width: '100%',
    padding: 16,
    background: t.primary,
    color: t.primaryText,
    fontSize: 18,
    fontWeight: 'bold',
    border: 'none',
    borderRadius: 12,
    cursor: 'pointer'
  },
  allDone: {
    textAlign: 'center',
    padding: 32,
    background: t.card,
    borderRadius: 12,
    color: t.muted
  },
  reviewContainer: {
    maxWidth: 600,
    margin: '0 auto',
    ...(compact ? {} : { height: 'calc(100vh - 116px)' }),
    display: 'flex',
    flexDirection: 'column',
    gap: compact ? 10 : 14,
    padding: compact ? '4px 0' : '8px 0'
  },
  cardInfo: {
    textAlign: 'center',
    color: t.muted,
    fontSize: 14,
    fontWeight: 'bold'
  },
  colorDot: {
    width: 10,
    height: 10,
    borderRadius: '50%'
  },
  card: {
    background: t.card,
    borderWidth: compact ? 1 : 2,
    borderStyle: 'solid',
    borderRadius: compact ? 10 : 16,
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    overflow: compact ? 'auto' : 'hidden',
    ...(compact ? { scrollbarWidth: 'thin' as const } : {})
  },
  cardFront: {
    padding: compact ? '14px 14px' : '18px 24px',
    flex: compact ? '1 0 auto' : 1,
    minHeight: 0,
    overflow: compact ? 'visible' : 'auto',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
  },
  contextSentence: {
    fontSize: compact ? 21 : 20,
    lineHeight: compact ? 1.45 : 1.6,
    color: t.text,
    textAlign: 'center'
  },
  clozeWord: {
    fontWeight: 'bold',
    color: t.cloze,
    borderBottom: `2px dashed ${t.cloze}`,
    margin: '0 6px'
  },
  hintPrompt: {
    fontSize: compact ? 20 : 24,
    color: t.strong,
    textAlign: 'center'
  },
  cardBack: {
    padding: compact ? '10px 14px' : '14px 24px',
    borderTop: `1px solid ${t.borderSoft}`,
    background: t.inset,
    textAlign: 'center'
  },
  targetWord: {
    fontSize: compact ? 20 : 24,
    fontWeight: 'bold',
    color: t.strong,
    marginBottom: compact ? 4 : 8,
    flexWrap: 'wrap',
    display: 'flex',
    alignItems: compact ? 'center' : 'baseline',
    justifyContent: 'center',
    gap: 8
  },
  phonetics: {
    fontSize: compact ? 14 : 16,
    fontWeight: 'normal',
    color: t.muted
  },
  translation: {
    fontSize: compact ? 14 : 18,
    color: t.muted
  },
  showBtn: {
    padding: compact ? 12 : 16,
    background: t.btnBg,
    color: t.btnText,
    fontSize: compact ? 15 : 16,
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer'
  },
  gradeBtn: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 2,
    padding: '10px 4px',
    fontSize: 15,
    fontWeight: 700,
    border: 'none',
    borderRadius: 10,
    cursor: 'pointer',
  },
  gradeBtnHint: {
    fontSize: 11,
    fontWeight: 500,
    opacity: 0.7,
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
    textShadow: t.rewardShadow,
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

function Pill({ value, label, color, t }: { value: string; label: string; color: string; t: StudyTheme }) {
  return (
    <div style={{ background: t.pillBg, border: `1px solid ${t.borderSoft}`, borderRadius: 12, padding: '10px 16px', minWidth: 88 }}>
      <div style={{ fontSize: 20, fontWeight: 'bold', color }}>{value}</div>
      <div style={{ fontSize: 12, color: t.muted, marginTop: 2 }}>{label}</div>
    </div>
  )
}

function SessionSummary({ correct, total, maxCombo, sparksEarned, mode, onClose, onRestart, viewportOffset, theme: t, compact, closeLabel }: {
  closeLabel: string
  viewportOffset: number
  theme: StudyTheme
  compact: boolean
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
    ? { emoji: '🎉', title: 'Session complete!', color: t.rank.done }
    : accuracy >= 100 ? { emoji: '🏆', title: 'Perfect!', color: t.rank.perfect }
      : accuracy >= 80 ? { emoji: '🎉', title: 'Great job!', color: t.rank.great }
        : accuracy >= 50 ? { emoji: '💪', title: 'Nice work!', color: t.rank.nice }
          : { emoji: '🌱', title: 'Keep practicing!', color: t.rank.keep }

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
    <div style={{ position: 'relative', maxWidth: 600, margin: '0 auto', padding: '8px 0', overflow: 'hidden', minHeight: compact ? undefined : `calc(100vh - ${viewportOffset}px)`, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
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
        background: t.summaryBg,
        border: `1px solid ${t.summaryBorder}`,
        borderRadius: 20,
        padding: compact ? '18px 14px' : '24px 24px',
        boxShadow: t.summaryShadow,
        textAlign: 'center',
        position: 'relative',
        zIndex: 2,
      }}>
        <div className="cxt-rank-pop" style={{ fontSize: 46, filter: `drop-shadow(0 0 14px ${rank.color}66)` }}>
          {rank.emoji}
        </div>
        <div style={{ fontSize: 23, fontWeight: 'bold', color: rank.color, marginTop: 4 }}>{rank.title}</div>
        <div style={{ color: t.muted, marginTop: 6, fontSize: 14 }}>
          {isPassive ? `Reviewed ${total} cards` : `You completed ${total} cards`}
        </div>

        {!isPassive && (
          <div style={{ position: 'relative', width: 148, height: 148, margin: '14px auto 4px' }}>
            <svg width="148" height="148" style={{ transform: 'rotate(-90deg)' }}>
              <circle cx="74" cy="74" r={R} stroke={t.ringTrack} strokeWidth={SW} fill="none" />
              <circle
                cx="74" cy="74" r={R} stroke={rank.color} strokeWidth={SW} fill="none"
                strokeDasharray={CIRC} strokeDashoffset={dashoffset} strokeLinecap="round"
                style={{ transition: 'stroke-dashoffset 1s cubic-bezier(0.22, 1, 0.36, 1)' }}
              />
            </svg>
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ fontSize: 34, fontWeight: 'bold', color: t.strong }}>{accuracy}%</div>
              <div style={{ fontSize: 12, color: t.muted }}>{correct}/{total}</div>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'center', gap: 12, flexWrap: 'wrap', marginTop: isPassive ? 20 : 6, marginBottom: 18 }}>
          {!isPassive && <Pill value={`${correct}`} label="Correct" color={t.pill.correct} t={t} />}
          {!isPassive && <Pill value={`🔥×${maxCombo}`} label="Best streak" color={t.pill.streak} t={t} />}
          <Pill value={`+${sparksEarned} 🔥`} label="Sparks earned" color={t.pill.sparks} t={t} />
        </div>

        <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
          <button
            onClick={onRestart}
            style={{ background: 'transparent', color: t.link, border: `1px solid ${t.border}`, borderRadius: 10, padding: compact ? '10px 16px' : '12px 24px', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}
          >
            Study again
          </button>
          <button
            ref={closeBtnRef}
            onClick={onClose}
            style={{ background: t.primary, color: t.primaryText, border: 'none', borderRadius: 10, padding: compact ? '10px 16px' : '12px 24px', fontSize: 15, fontWeight: 'bold', cursor: 'pointer' }}
          >
            {closeLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
