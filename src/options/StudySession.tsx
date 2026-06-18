import { useEffect, useState } from 'react'
import { SavedItem, BookmarkColor, BOOKMARK_COLORS, Settings, StudyMode } from '../shared/types'

const ALL_COLORS: BookmarkColor[] = [
  'red', 'yellow', 'cyan', 'green', 'blue',
  'orange', 'purple', 'pink', 'teal', 'gray'
]

export default function StudySession() {
  const [items, setItems] = useState<SavedItem[]>([])
  const [selectedColors, setSelectedColors] = useState<Set<BookmarkColor>>(new Set(['red']))
  const [sessionActive, setSessionActive] = useState(false)
  const [activeItem, setActiveItem] = useState<SavedItem | null>(null)
  const [showAnswer, setShowAnswer] = useState(false)
  const [showHint, setShowHint] = useState(false)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [sessionQueue, setSessionQueue] = useState<SavedItem[]>([])
  const [sessionTotal, setSessionTotal] = useState(0)
  const [sessionMode, setSessionMode] = useState<StudyMode>('passive')
  const [verificationPassed, setVerificationPassed] = useState(false)
  const [userAnswer, setUserAnswer] = useState('')
  const [mcOptions, setMcOptions] = useState<string[]>([])
  const [isRecording, setIsRecording] = useState(false)
  const [speechError, setSpeechError] = useState('')
  const [selectedMode, setSelectedMode] = useState<StudyMode>('passive')
  const [sessionScore, setSessionScore] = useState({ correct: 0, giveUps: 0 })
  const [showSessionSummary, setShowSessionSummary] = useState(false)
  const [verifyError, setVerifyError] = useState(false)
  const [wrongOptions, setWrongOptions] = useState<Set<string>>(new Set())

  useEffect(() => {
    loadItems()
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (s: Settings) => {
      if (s) setSettings(s)
    })
  }, [])

  function loadItems() {
    chrome.runtime.sendMessage({ type: 'GET_ITEMS' }, (list: SavedItem[]) => {
      if (list) setItems(list)
    })
  }

  function toggleColor(c: BookmarkColor) {
    const next = new Set(selectedColors)
    if (next.has(c)) next.delete(c)
    else next.add(c)
    setSelectedColors(next)
  }

  function speakText(text: string) {
    chrome.tts.stop()

    if (settings?.readAloud) {
      const r = settings.readAloud
      chrome.tts.speak(text, {
        pitch: r.pitch,
        rate: r.speed,
        voiceName: r.voice || undefined,
        volume: r.volume
      })
    } else {
      chrome.tts.speak(text)
    }
  }

  const matchingItems = items.filter(i => selectedColors.has(i.color))
  const upcomingItems = matchingItems
    .filter(i => (i.nextReview || 0) > Date.now())
    .sort((a, b) => (a.nextReview || 0) - (b.nextReview || 0))

  function getDueItems() {
    const now = Date.now()
    return matchingItems
      .filter(i => i.nextReview !== undefined && i.nextReview <= now)
      .sort((a, b) => (a.nextReview || 0) - (b.nextReview || 0))
  }

  const dueItems = getDueItems()

  function generateMcOptions(item: SavedItem, allItems: SavedItem[]) {
    const otherItems = allItems.filter(i => i.id !== item.id && i.text)
    const shuffled = [...otherItems].sort(() => 0.5 - Math.random())
    const distractors = shuffled.slice(0, 3).map(i => i.text)
    const options = [item.text, ...distractors].sort(() => 0.5 - Math.random())
    setMcOptions(options)
  }

  function startSession(force: boolean = false, mode: StudyMode = 'passive') {
    let queue = matchingItems
    if (!force) {
      queue = getDueItems()
    }

    if (queue.length > 0) {
      setSessionQueue(queue)
      setSessionTotal(queue.length)
      setActiveItem(queue[0])
      setSessionMode(mode)
      setShowAnswer(false)
      setShowHint(!!settings?.showHintInitially)
      setVerificationPassed(mode === 'passive')
      setUserAnswer('')
      setSpeechError('')
      setVerifyError(false)
      setWrongOptions(new Set())
      setSessionScore({ correct: 0, giveUps: 0 })
      setShowSessionSummary(false)
      if (mode === 'multiple_choice') generateMcOptions(queue[0], items)
      if (mode === 'listening') {
        setTimeout(() => speakText((queue[0].prefix || '') + queue[0].text + (queue[0].suffix || '')), 300)
      }
      setSessionActive(true)
    }
  }

  function handleReview(rating: 1 | 2 | 3 | 4) {
    if (!activeItem) return
    chrome.runtime.sendMessage(
      { type: 'REVIEW_ITEM', payload: { id: activeItem.id, rating } },
      () => {
        loadItems()
        setTimeout(() => {
          setSessionQueue(prev => {
            const nextQueue = prev.slice(1)
            if (nextQueue.length > 0) {
              setActiveItem(nextQueue[0])
              setShowAnswer(false)
              setShowHint(!!settings?.showHintInitially)
              setVerificationPassed(sessionMode === 'passive')
              setUserAnswer('')
              setSpeechError('')
              setVerifyError(false)
              setWrongOptions(new Set())
              if (sessionMode === 'multiple_choice') generateMcOptions(nextQueue[0], items)
              if (sessionMode === 'listening') {
                setTimeout(() => speakText((nextQueue[0].prefix || '') + nextQueue[0].text + (nextQueue[0].suffix || '')), 300)
              }
            } else {
              setActiveItem(null)
              setSessionActive(false)
              if (sessionMode !== 'passive') setShowSessionSummary(true)
            }
            return nextQueue
          })
        }, 300)
      }
    )
  }

  function handleVerify(value: string) {
    if (!activeItem) return
    if (value.trim().toLowerCase() === activeItem.text.trim().toLowerCase()) {
      setVerificationPassed(true)
      setShowAnswer(true)
      setSessionScore(prev => ({ ...prev, correct: prev.correct + 1 }))
      setVerifyError(false)
      speakText(activeItem.text)
    } else {
      setVerifyError(true)
      if (sessionMode === 'multiple_choice') {
        setWrongOptions(prev => new Set(prev).add(value))
        speakText(activeItem.text)
      }
    }
  }

  function handleGiveUp() {
    setVerificationPassed(true) // Reveals answer and SRS grading buttons
    setShowAnswer(true)
    setSessionScore(prev => ({ ...prev, giveUps: prev.giveUps + 1 }))
    if (activeItem) {
      speakText(activeItem.text)
    }
    // Do not auto-grade. Let the user manually click an SRS rating to advance.
  }

  function startSpeaking() {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      setSpeechError('Speech recognition is not supported in your browser.')
      return
    }

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    const recognition = new SpeechRecognition()
    recognition.lang = 'en-US'
    recognition.interimResults = false
    recognition.maxAlternatives = 1

    recognition.onstart = () => {
      setIsRecording(true)
      setSpeechError('')
    }

    recognition.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript
      setUserAnswer(transcript)
      if (transcript.trim().toLowerCase().replace(/[.,?!]/g, '') === activeItem?.text.trim().toLowerCase().replace(/[.,?!]/g, '')) {
        setVerificationPassed(true)
        setShowAnswer(true)
        setSessionScore(prev => ({ ...prev, correct: prev.correct + 1 }))
        speakText(activeItem?.text || '')
      } else {
        setSpeechError(`You said: "${transcript}". Try again!`)
      }
    }

    recognition.onerror = (event: any) => {
      setSpeechError(`Error: ${event.error}`)
      setIsRecording(false)
    }

    recognition.onend = () => {
      setIsRecording(false)
    }

    recognition.start()
  }

  if (sessionActive && activeItem) {
    const isFlashcard = !!activeItem.translation

    return (
      <div style={styles.reviewContainer}>
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

        <div key={activeItem.id} style={{ ...styles.card, borderColor: BOOKMARK_COLORS[activeItem.color] }}>
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
                  {(showAnswer || sessionMode === 'listening') && (
                    <button
                      style={styles.speakerBtn}
                      onClick={() => speakText((activeItem.prefix || '') + activeItem.text + (activeItem.suffix || ''))}
                      title="Read sentence aloud"
                    >
                      🔊
                    </button>
                  )}
                </div>

                {!verificationPassed && (
                  <div style={{ marginTop: '10px', width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
                    {(sessionMode === 'typing' || sessionMode === 'listening') && (
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
                          onKeyDown={(e) => e.key === 'Enter' && handleVerify(userAnswer)}
                        />
                        {verifyError && <span style={{ color: '#ff6b6b', fontSize: '14px' }}>Incorrect, try again!</span>}
                      </div>
                    )}

                    {sessionMode === 'speaking' && (
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
                        <button
                          style={{
                            ...styles.showBtn,
                            borderRadius: '50%', width: '64px', height: '64px', fontSize: '24px',
                            background: isRecording ? '#ff6b6b' : '#4a5a9a'
                          }}
                          onClick={startSpeaking}
                        >
                          🎤
                        </button>
                        {isRecording && <span style={{ color: '#ff6b6b' }}>Listening...</span>}
                        {speechError && <span style={{ color: '#ffb36b', fontSize: '14px' }}>{speechError}</span>}
                      </div>
                    )}

                    {sessionMode === 'multiple_choice' && (
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
                            style={{ ...styles.startBtn, marginTop: '8px', padding: '10px 24px', fontSize: '16px', width: 'auto' }}
                            onClick={() => {
                              setSessionScore(prev => ({ ...prev, giveUps: prev.giveUps + 1 }))
                              handleReview(1) // Auto-grade as Again
                            }}
                          >
                            Next
                          </button>
                        )}
                      </div>
                    )}

                    {sessionMode !== 'multiple_choice' && !showHint && (
                      <button
                        style={{ ...styles.showBtn, padding: '8px 16px', fontSize: '14px', background: '#2a2a4a' }}
                        onClick={() => setShowHint(true)}
                      >
                        Show Hint
                      </button>
                    )}

                    {showHint && sessionMode !== 'multiple_choice' && (
                      <div style={{ color: '#8888aa', fontStyle: 'italic', fontSize: '18px', textAlign: 'center' }}>
                        Hint: {sessionMode === 'listening' 
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
                      onClick={() => speakText(activeItem.text)}
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
            {(sessionMode === 'typing' || sessionMode === 'listening') && (
               <button style={{ ...styles.showBtn, flex: 1, background: '#4a5a9a' }} onClick={() => handleVerify(userAnswer)}>
                 Verify
               </button>
            )}
          </div>
        ) : !showAnswer && sessionMode === 'passive' ? (
          <button style={styles.showBtn} onClick={() => {
            setShowAnswer(true)
            if (activeItem.text) speakText(activeItem.text)
          }}>
            Show Answer
          </button>
        ) : (
          <div style={styles.ratingButtons}>
            <button
              style={{ ...styles.rateBtn, background: '#ff6b6b' }}
              onClick={() => handleReview(1)}
              title="You completely forgot this. Reset its progress and show it again soon."
            >
              Again
            </button>
            <button
              style={{ ...styles.rateBtn, background: '#ffb36b' }}
              onClick={() => handleReview(2)}
              title="You remembered it, but it was difficult. Show it again soon, and decrease its future intervals."
            >
              Hard
            </button>
            <button
              style={{ ...styles.rateBtn, background: '#6bff9e', color: '#112211' }}
              onClick={() => handleReview(3)}
              title="You remembered it well. Increase the interval until you see it again."
            >
              Good
            </button>
            <button
              style={{ ...styles.rateBtn, background: '#6bcfff', color: '#111122' }}
              onClick={() => handleReview(4)}
              title="This was too easy. Greatly increase the interval until you see it again."
            >
              Easy
            </button>
          </div>
        )}
      </div>
    )
  }
  if (showSessionSummary) {
    return (
      <div style={styles.dashboard}>
        <div style={styles.headerRow}>
          <h2>Session Complete!</h2>
        </div>
        <div style={styles.allDone}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>🏆</div>
          <h3 style={{ margin: '0 0 12px 0', color: '#ffffff' }}>Great job!</h3>
          <p style={{ margin: '0 0 24px 0' }}>You completed {sessionTotal} cards.</p>
          <div style={{ display: 'flex', justifyContent: 'center', gap: '24px', marginBottom: '32px' }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 32, color: '#6bff9e', fontWeight: 'bold' }}>{sessionScore.correct}</div>
              <div style={{ color: '#8888aa', fontSize: 14 }}>Verified Correctly</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 32, color: '#ffb36b', fontWeight: 'bold' }}>{sessionScore.giveUps}</div>
              <div style={{ color: '#8888aa', fontSize: 14 }}>Given Up</div>
            </div>
          </div>
          <button style={{ ...styles.startBtn, width: 'auto', padding: '12px 32px' }} onClick={() => setShowSessionSummary(false)}>
            Back to Study Dashboard
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={styles.dashboard}>
      <div style={styles.headerRow}>
        <h2>Study</h2>
      </div>

      <div style={styles.colorFilterPanel}>
        <h3>Select Colors to Study</h3>
        <div style={styles.colorGrid}>
          {ALL_COLORS.map(c => {
            const isSelected = selectedColors.has(c)
            const count = items.filter(item => item.color === c).length
            return (
              <div
                key={c}
                style={{
                  ...styles.colorToggle,
                  backgroundColor: isSelected ? BOOKMARK_COLORS[c] : '#1a1a2e',
                  borderColor: BOOKMARK_COLORS[c],
                  color: isSelected ? '#111122' : '#8888aa'
                }}
                onClick={() => toggleColor(c)}
              >
                {c}
                {count > 0 && (
                  <span style={{
                    position: 'absolute',
                    top: -10,
                    right: -10,
                    background: '#111122',
                    color: '#ffffff',
                    borderRadius: '12px',
                    minWidth: 22,
                    height: 22,
                    padding: '0 6px',
                    fontSize: 11,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontWeight: 'bold',
                    border: `2px solid ${BOOKMARK_COLORS[c]}`,
                    boxShadow: '0 2px 4px rgba(0,0,0,0.5)',
                    boxSizing: 'border-box',
                    zIndex: 2
                  }}>
                    {count > 99 ? '99+' : count}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <div style={styles.statsGrid}>
        <div style={styles.statCard}>
          <div style={{ ...styles.statValue, color: dueItems.length > 0 ? '#6bff9e' : '#8888aa' }}>
            {dueItems.length}
          </div>
          <div style={styles.statLabel}>Cards Due for Selected Colors</div>
        </div>
      </div>

      {dueItems.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', background: '#1a1a2e', padding: '12px', borderRadius: '8px', border: '1px solid #2a2a4a' }}>
            <label style={{ color: '#e0e0e0', fontWeight: 'bold' }}>Study Mode:</label>
            <select
              style={{ padding: '8px', borderRadius: '4px', background: '#111122', color: 'white', border: '1px solid #3a3a5a' }}
              value={selectedMode}
              onChange={(e) => setSelectedMode(e.target.value as StudyMode)}
            >
              <option value="passive">Passive Flashcard</option>
              <option value="typing">Typing (Active Recall)</option>
              <option value="speaking">Speaking (Pronunciation)</option>
              <option value="listening">Listening (Dictation)</option>
              <option value="multiple_choice">Multiple Choice</option>
            </select>
          </div>

          <button style={styles.startBtn} onClick={() => startSession(false, selectedMode)}>
            Start Studying ({dueItems.length} due cards)
          </button>

          {matchingItems.length > dueItems.length && (
            <button
              style={{ ...styles.startBtn, background: 'transparent', border: '1px solid #3a3a5a', padding: '10px 16px', fontSize: 14, width: 'auto' }}
              onClick={() => startSession(true, selectedMode)}
            >
              Study All {matchingItems.length} Selected Cards Anyway (Ignore Schedule)
            </button>
          )}
        </div>
      ) : (
        <div style={styles.allDone}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>🎉</div>
          <h3 style={{ margin: '0 0 12px 0', color: '#ffffff' }}>You're all caught up!</h3>
          <p style={{ margin: 0 }}>You have reviewed all scheduled cards for these colors.</p>

          {upcomingItems.length > 0 && (
            <p style={{ marginTop: 12, color: '#6bcfff', fontWeight: 'bold' }}>
              Next card is due for review in {formatTime(upcomingItems[0].nextReview! - Date.now())}.
            </p>
          )}

          {matchingItems.length > 0 && (
            <div style={{ marginTop: 32 }}>
              <div style={{ display: 'flex', gap: '12px', alignItems: 'center', justifyContent: 'center', marginBottom: '16px' }}>
                <label style={{ color: '#e0e0e0', fontWeight: 'bold' }}>Study Mode:</label>
                <select
                  style={{ padding: '8px', borderRadius: '4px', background: '#111122', color: 'white', border: '1px solid #3a3a5a' }}
                  value={selectedMode}
                  onChange={(e) => setSelectedMode(e.target.value as StudyMode)}
                >
                  <option value="passive">Passive Flashcard</option>
                  <option value="typing">Typing (Active Recall)</option>
                  <option value="speaking">Speaking (Pronunciation)</option>
                  <option value="listening">Listening (Dictation)</option>
                  <option value="multiple_choice">Multiple Choice</option>
                </select>
              </div>
              <button
                style={{ ...styles.startBtn, background: '#3a3a5a', padding: '12px 20px', fontSize: 16 }}
                onClick={() => startSession(true, selectedMode)}
              >
                Study {matchingItems.length} Selected Color Cards Anyway (Ignore Schedule)
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function formatTime(ms: number) {
  if (ms <= 0) return 'now'
  const mins = Math.floor(ms / 60000)
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'}`
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
  colorFilterPanel: {
    background: '#1a1a2e',
    border: '1px solid #2a2a4a',
    borderRadius: 12,
    padding: 24,
    marginBottom: 24
  },
  colorGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(5, 1fr)',
    gap: 12,
    marginTop: 16
  },
  colorToggle: {
    position: 'relative',
    padding: '8px',
    textAlign: 'center',
    borderRadius: 6,
    borderWidth: 2,
    borderStyle: 'solid',
    cursor: 'pointer',
    fontWeight: 'bold',
    fontSize: 12,
    textTransform: 'capitalize',
    transition: 'all 0.2s'
  },
  statsGrid: {
    marginBottom: 32
  },
  statCard: {
    background: '#1a1a2e',
    border: '1px solid #2a2a4a',
    borderRadius: 12,
    padding: 24,
    textAlign: 'center'
  },
  statValue: {
    fontSize: 36,
    fontWeight: 'bold',
    color: '#ffffff',
    marginBottom: 8
  },
  statLabel: {
    color: '#8888aa',
    fontSize: 14
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
    display: 'flex',
    flexDirection: 'column',
    gap: 24,
    padding: '20px 0'
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
    minHeight: 300,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden'
  },
  cardFront: {
    padding: 32,
    flex: 1,
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
    padding: 32,
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
  ratingButtons: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 12
  },
  rateBtn: {
    padding: 16,
    border: 'none',
    borderRadius: 8,
    fontSize: 16,
    fontWeight: 'bold',
    cursor: 'pointer',
    color: 'white'
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
  }
}
