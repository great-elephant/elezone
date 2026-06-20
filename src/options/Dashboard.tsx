import { useEffect, useState } from 'react'
import { ActivityLog, Settings, DEFAULT_SETTINGS } from '../shared/types'

function getLocalYMD(d: Date): string {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

import { LEVELS_100, getLevelFromXP, getXPForLevel } from '../shared/levels'

function calculateLevel(xp: number) {
  const currentLevel = getLevelFromXP(xp);

  // Cap at max level 100
  const actualLevel = Math.min(100, currentLevel);
  const currentLevelData = LEVELS_100[actualLevel - 1];
  const nextLevelData = actualLevel < 100 ? LEVELS_100[actualLevel] : null;

  const currentLevelXP = getXPForLevel(actualLevel);
  const nextLevelXP = getXPForLevel(actualLevel + 1);
  const progress = Math.max(0, Math.min(100, ((xp - currentLevelXP) / (nextLevelXP - currentLevelXP)) * 100));

  return {
    currentLevel: actualLevel,
    title: currentLevelData.title,
    icon: currentLevelData.icon,
    currentLevelXP,
    nextLevelXP,
    progress,
    nextLevelData
  };
}

const ROASTS = [
  "Blink twice if you're being held hostage by this app.",
  "Touch grass? Bro needs to touch a whole forest.",
  "Your chair now has a permanent indent of your butt.",
  "Legend says if you reach Level 100, you actually become Ỉ Mâu Sần Nồ Đe Mịt.",
  "Level 100: The 'I have zero rizz but I speak English' rank.",
  "Are you allergic to sunlight? Go outside!",
  "Breaking News: Local nerd refuses to stop learning.",
  "Even Shakespeare is telling you to chill out bro."
];

export default function Dashboard({ onNavigate }: { onNavigate?: (tab: 'dashboard' | 'library' | 'settings') => void }) {
  const [log, setLog] = useState<ActivityLog>({})
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [tooltip, setTooltip] = useState<{ visible: boolean, text: string, x: number, y: number }>({ visible: false, text: '', x: 0, y: 0 })
  const [slackingState, setSlackingState] = useState<{ isSlacking: boolean, level: number, message: string } | null>(null)

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_ACTIVITY_LOG' }, (res) => {
      if (res) setLog(res)
    })
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (s) => {
      if (s) setSettings(s)
    })
    chrome.storage.local.get('slacking_state', (res) => {
      if (res.slacking_state) setSlackingState(res.slacking_state)
    })

    const handleStorageChange = (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => {
      if (areaName === 'local') {
        if (changes['cxt_activity_log']) {
          setLog(changes['cxt_activity_log'].newValue || {})
        }
        if (changes['settings']) {
          setSettings(changes['settings'].newValue || DEFAULT_SETTINGS)
        }
        if (changes['slacking_state']) {
          setSlackingState(changes['slacking_state'].newValue || null)
        }
      }
    }
    chrome.storage.onChanged.addListener(handleStorageChange)
    return () => chrome.storage.onChanged.removeListener(handleStorageChange)
  }, [])

  const goal = settings.gamification?.dailyGoalPoints || 100
  const todayDate = new Date()
  const todayStr = getLocalYMD(todayDate)
  const todayPoints = log[todayStr]?.points || 0

  // Calculate Lifetime XP
  const lifetimeXP = Object.values(log).reduce((sum, day) => sum + (day.points || 0), 0)
  const levelInfo = calculateLevel(lifetimeXP)

  // Calculate Streak
  let streak = 0
  let tempDate = new Date()
  const hitToday = todayPoints >= goal

  if (hitToday) {
    streak = 1
    tempDate.setDate(tempDate.getDate() - 1)
  } else {
    tempDate.setDate(tempDate.getDate() - 1)
  }

  while (true) {
    const s = getLocalYMD(tempDate)
    const p = log[s]?.points || 0
    if (p >= goal) {
      streak++
      tempDate.setDate(tempDate.getDate() - 1)
    } else {
      break
    }
  }

  // Progress Ring logic
  const progress = Math.min(100, Math.round((todayPoints / goal) * 100))
  const ringRadius = 70
  const ringCircumference = 2 * Math.PI * ringRadius
  const dashoffset = ringCircumference - (progress / 100) * ringCircumference

  // Heatmap generation
  const weeks: { date: string, level: number, points: number }[][] = []

  const monthLabels: { label: string, index: number }[] = []
  let currentWeek: { date: string, level: number, points: number }[] = []

  let iterDate = new Date(todayDate)
  iterDate.setDate(iterDate.getDate() - 180)

  // Back up iterDate to the previous Sunday
  while (iterDate.getDay() !== 0) {
    iterDate.setDate(iterDate.getDate() - 1)
  }

  let colIndex = 0
  while (iterDate <= todayDate) {
    if (currentWeek.length === 7) {
      weeks.push(currentWeek)
      currentWeek = []
      colIndex++
      if (weeks.length > 55) {
        console.warn('Infinite loop guard triggered in heatmap generation')
        break
      }
    }

    if (iterDate.getDate() === 1) { // First day of the month
      monthLabels.push({ label: iterDate.toLocaleString('default', { month: 'short' }), index: colIndex })
    }

    const s = getLocalYMD(iterDate)
    const p = log[s]?.points || 0
    let level = 0
    if (p > 0) level = 1
    if (p >= goal * 0.3) level = 2
    if (p >= goal * 0.7) level = 3
    if (p >= goal) level = 4

    currentWeek.push({ date: s, level, points: p })
    iterDate.setDate(iterDate.getDate() + 1)
  }
  if (currentWeek.length > 0) {
    while (currentWeek.length < 7) currentWeek.push({ date: '', level: -1, points: 0 })
    weeks.push(currentWeek)
  }

  const getHeatmapColor = (level: number) => {
    switch (level) {
      case 1: return '#0e4429'
      case 2: return '#006d32'
      case 3: return '#26a641'
      case 4: return '#39d353'
      case -1: return 'transparent'
      default: return '#161b22'
    }
  }

  return (
    <div className="dashboard-root" style={{ color: '#fff', width: '100%', borderRadius: '16px' }}>

      <style>{`
        .heatmap-square {
          position: relative;
        }
        .roast-banner {
          grid-column: 1 / -1;
          background: #2a1111;
          padding: 12px 16px;
          border-radius: 6px;
          border: 1px solid #4a2222;
          display: flex;
          align-items: center;
          gap: 12px;
          font-size: 13px;
        }
        .roast-btn {
          background: transparent;
          color: #ff6b6b;
          border: 1px solid #ff6b6b;
          padding: 6px 12px;
          border-radius: 4px;
          font-weight: 500;
          cursor: pointer;
          font-size: 12px;
          white-space: nowrap;
          transition: background 0.2s;
        }
        .roast-btn:hover {
          background: rgba(255, 107, 107, 0.1);
        }
      `}</style>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '24px', width: '100%' }}>

        {/* Roast Banner */}
        {slackingState && (
          <div className="roast-banner">
            <div style={{ flex: 1, color: '#e0e0e0', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span>{slackingState.message}</span>
            </div>
            <button
              className="roast-btn"
              onClick={() => { if (onNavigate) onNavigate('library') }}>
              Ôn tập ngay
            </button>
            <button
              onClick={() => chrome.storage.local.remove('slacking_state')}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#ff8888',
                cursor: 'pointer',
                padding: '4px',
                fontSize: '14px',
                display: 'flex',
                alignItems: 'center',
                opacity: 0.7,
                marginLeft: '4px'
              }}
              title="Tạm ẩn cảnh báo"
              onMouseOver={e => e.currentTarget.style.opacity = '1'}
              onMouseOut={e => e.currentTarget.style.opacity = '0.7'}
            >
              ✕
            </button>
          </div>
        )}

        {/* Player Profile Banner */}
        <div style={{ gridColumn: '1 / -1', background: 'linear-gradient(135deg, #1e1e32 0%, #111122 100%)', padding: '30px', borderRadius: '16px', border: '1px solid #3a3a6a', display: 'flex', flexDirection: 'column', gap: '20px', boxShadow: '0 10px 30px rgba(0,0,0,0.3)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
            <div>
              <div style={{ fontSize: '0.9em', color: '#aaa', textTransform: 'uppercase', letterSpacing: '2px', marginBottom: '8px', fontWeight: 'bold' }}>Current Rank</div>
              <div style={{ fontSize: '2.2em', fontWeight: 'bold', color: '#fff', display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span style={{ fontSize: '1.2em', filter: 'drop-shadow(0 0 10px rgba(255,215,0,0.5))' }}>{levelInfo.icon}</span>
                Level {levelInfo.currentLevel}: {levelInfo.title}
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '2em', fontWeight: 'bold', color: '#46ff6a', textShadow: '0 0 15px rgba(70,255,106,0.3)' }}>
                {lifetimeXP} <span style={{ fontSize: '0.5em', color: '#aaa', textTransform: 'uppercase', letterSpacing: '1px' }}>Firepower</span>
              </div>
            </div>
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9em', color: '#ccc', marginBottom: '8px', fontWeight: 'bold' }}>
              <span>Progress to Level {levelInfo.currentLevel + 1}</span>
              <span>{lifetimeXP} / {levelInfo.nextLevelXP} Sparks</span>
            </div>
            <div style={{ width: '100%', height: '14px', background: '#0d0d1a', borderRadius: '7px', overflow: 'hidden', border: '1px solid #2a2a4a', boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.5)' }}>
              <div style={{ height: '100%', width: `${levelInfo.progress}%`, background: 'linear-gradient(90deg, #2ea043, #46ff6a)', borderRadius: '7px', transition: 'width 1.5s ease-in-out', boxShadow: '0 0 10px rgba(70,255,106,0.5)' }}></div>
            </div>
            <div style={{ fontSize: '0.8em', color: '#88a', marginTop: '12px', textAlign: 'center' }}>
              {levelInfo.nextLevelData ? (
                levelInfo.currentLevel === 99 ? (
                  <>Next up: <strong>❓ Level 100 ({ROASTS[lifetimeXP % ROASTS.length]})</strong></>
                ) : (
                  <>Next up: <strong>{levelInfo.nextLevelData.icon} {levelInfo.nextLevelData.title}</strong> at Level {levelInfo.currentLevel + 1}</>
                )
              ) : (
                <>You have reached the highest level!</>
              )}
            </div>
          </div>
        </div>

        {/* Progress Ring Card */}
        <div style={{ background: '#111122', padding: '30px', borderRadius: '16px', border: '1px solid #3a3a6a', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', boxShadow: '0 10px 30px rgba(0,0,0,0.15)' }}>
          <div style={{ fontSize: '1.1em', color: '#ccc', marginBottom: '20px', fontWeight: 'bold', letterSpacing: '1px', textTransform: 'uppercase' }}>Daily Goal</div>
          <div style={{ position: 'relative', width: '160px', height: '160px', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
            <svg width="160" height="160" style={{ position: 'absolute', transform: 'rotate(-90deg)' }}>
              <circle cx="80" cy="80" r="70" stroke="#161b22" strokeWidth="14" fill="none" />
              <circle cx="80" cy="80" r="70" stroke="#39d353" strokeWidth="14" fill="none"
                strokeDasharray={ringCircumference} strokeDashoffset={dashoffset} strokeLinecap="round"
                style={{ transition: 'stroke-dashoffset 0.8s ease' }} />
            </svg>
            <div style={{ textAlign: 'center', zIndex: 1 }}>
              <div style={{ fontSize: '2.5em', fontWeight: 'bold' }}>{todayPoints}</div>
              <div style={{ fontSize: '0.9em', color: '#aaa', fontWeight: 'bold' }}>/ {goal} Sparks</div>
            </div>
          </div>
        </div>

        {/* Streak Counter Card */}
        <div style={{ background: '#111122', padding: '30px', borderRadius: '16px', border: '1px solid #3a3a6a', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', boxShadow: '0 10px 30px rgba(0,0,0,0.15)' }}>
          <div style={{ fontSize: '4em', marginBottom: '10px', filter: hitToday ? 'drop-shadow(0 0 15px rgba(255, 120, 0, 0.6))' : 'grayscale(30%) opacity(0.8)' }}>
            {hitToday ? '🔥' : '🪵'}
          </div>
          <div style={{ fontSize: '3em', fontWeight: 'bold' }}>{streak}</div>
          <div style={{ color: '#aaa', fontWeight: 'bold', letterSpacing: '1px', textTransform: 'uppercase', fontSize: '0.9em' }}>Day Streak</div>
          <div style={{ marginTop: '15px', fontSize: '0.95em', color: hitToday ? '#39d353' : '#ffb36b', fontWeight: 'bold', lineHeight: '1.4', textAlign: 'center' }}>
            {hitToday
              ? '✅ Daily goal reached! The fire is blazing.'
              : `Earn ${goal - todayPoints} more Sparks to burn the wood!`}
          </div>
        </div>

        {/* Today's Breakdown */}
        <div style={{ gridColumn: '1 / -1', background: '#111122', padding: '20px 30px', borderRadius: '16px', border: '1px solid #3a3a6a', display: 'flex', justifyContent: 'space-around', boxShadow: '0 10px 30px rgba(0,0,0,0.15)' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '1.1em', color: '#ccc', marginBottom: '8px' }}>📖 Words Saved Today</div>
            <div style={{ fontSize: '2em', fontWeight: 'bold', color: '#6bcfff' }}>{log[todayStr]?.saved || 0}</div>
            <div style={{ fontSize: '0.9em', color: '#888' }}>+{settings.gamification?.pointsPerSave || 1} Sparks each</div>
          </div>
          <div style={{ width: '1px', background: '#3a3a6a' }}></div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '1.1em', color: '#ccc', marginBottom: '8px' }}>🧠 Cards Reviewed Today</div>
            <div style={{ fontSize: '2em', fontWeight: 'bold', color: '#ffb36b' }}>{log[todayStr]?.reviewed || 0}</div>
            <div style={{ fontSize: '0.9em', color: '#888' }}>+{settings.gamification?.pointsPerReview || 2} Sparks each</div>
          </div>
        </div>

        {/* Heatmap */}
        <div style={{ gridColumn: '1 / -1', background: '#111122', padding: '30px', borderRadius: '16px', border: '1px solid #3a3a6a', display: 'flex', flexDirection: 'column', alignItems: 'center', boxShadow: '0 10px 30px rgba(0,0,0,0.15)' }}>
          <div style={{ width: '100%', maxWidth: '780px' }}>
            <h3 style={{ margin: '0 0 24px 0', fontSize: '1.2em', color: '#fff', fontWeight: '600' }}>Activity in the last 6 months</h3>

            <div style={{ display: 'flex', width: '100%', position: 'relative' }}>

              {/* Left Axis */}
              <div style={{ width: '30px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '10px', color: '#888', marginTop: '17px' }}>
                {['', 'Mon', '', 'Wed', '', 'Fri', ''].map((lbl, i) => (
                  <div key={i} style={{ width: '100%', aspectRatio: '1/1', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: '4px' }}>
                    {lbl}
                  </div>
                ))}
              </div>

              {/* Grid Container */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>

                {/* Month Labels */}
                <div style={{ position: 'relative', height: '14px', width: '100%', marginBottom: '3px' }}>
                  {monthLabels.map(m => (
                    <div key={m.index + m.label} style={{ position: 'absolute', left: `${(m.index / weeks.length) * 100}%`, fontSize: '11px', color: '#888' }}>
                      {m.label}
                    </div>
                  ))}
                </div>

                {/* Squares */}
                <div style={{ display: 'flex', width: '100%', gap: '3px' }}>
                  {weeks.map((week, wIdx) => (
                    <div key={wIdx} style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '3px' }}>
                      {week.map((day, dIdx) => (
                        <div
                          key={dIdx}
                          className={day.level === -1 ? '' : 'heatmap-square'}
                          onMouseEnter={(e) => {
                            if (day.level === -1) return
                            const rect = e.currentTarget.getBoundingClientRect()
                            setTooltip({ visible: true, text: `${day.points} Sparks on ${day.date}`, x: rect.left + rect.width / 2, y: rect.top })
                          }}
                          onMouseLeave={() => setTooltip(prev => ({ ...prev, visible: false }))}
                          style={{
                            width: '100%', aspectRatio: '1/1',
                            backgroundColor: getHeatmapColor(day.level),
                            borderRadius: '2px',
                            opacity: day.level === -1 ? 0 : 1,
                            cursor: day.level === -1 ? 'default' : 'pointer',
                            border: day.date === todayStr ? '1px solid #fff' : 'none',
                            boxSizing: 'border-box'
                          }}
                        />
                      ))}
                    </div>
                  ))}
                </div>

              </div>

            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '3px', marginTop: '15px', fontSize: '11px', color: '#888' }}>
              <span style={{ marginRight: '6px' }}>Less</span>
              <div style={{ width: '11px', height: '11px', backgroundColor: getHeatmapColor(0), borderRadius: '2px' }} />
              <div style={{ width: '11px', height: '11px', backgroundColor: getHeatmapColor(1), borderRadius: '2px' }} />
              <div style={{ width: '11px', height: '11px', backgroundColor: getHeatmapColor(2), borderRadius: '2px' }} />
              <div style={{ width: '11px', height: '11px', backgroundColor: getHeatmapColor(3), borderRadius: '2px' }} />
              <div style={{ width: '11px', height: '11px', backgroundColor: getHeatmapColor(4), borderRadius: '2px' }} />
              <span style={{ marginLeft: '6px' }}>More</span>
            </div>

          </div>
        </div>
      </div>

      {/* Global Tooltip */}
      {tooltip.visible && (
        <div style={{
          position: 'fixed',
          top: tooltip.y - 8,
          left: tooltip.x,
          transform: 'translate(-50%, -100%)',
          background: '#2a2a4a',
          color: '#fff',
          padding: '6px 10px',
          borderRadius: '6px',
          fontSize: '12px',
          whiteSpace: 'nowrap',
          zIndex: 9999,
          pointerEvents: 'none',
          boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
          fontWeight: 500
        }}>
          {tooltip.text}
          <div style={{
            position: 'absolute',
            top: '100%',
            left: '50%',
            transform: 'translateX(-50%)',
            borderWidth: '5px',
            borderStyle: 'solid',
            borderColor: '#2a2a4a transparent transparent transparent'
          }}></div>
        </div>
      )}

      {/* Floating Help Button */}
      <button
        onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL("src/options/guide.html") })}
        style={{
          position: 'fixed',
          bottom: '30px',
          right: '30px',
          width: '44px',
          height: '44px',
          borderRadius: '22px',
          backgroundColor: '#111122',
          color: '#5a5a8a',
          border: '1px solid #2a2a4a',
          cursor: 'pointer',
          boxShadow: '0 4px 10px rgba(0,0,0,0.3)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 1000,
          transition: 'all 0.2s ease'
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = '#2a2a4a';
          e.currentTarget.style.color = '#c0c0e0';
          e.currentTarget.style.transform = 'translateY(-2px)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = '#111122';
          e.currentTarget.style.color = '#5a5a8a';
          e.currentTarget.style.transform = 'translateY(0)';
        }}
        title="View Feature Guide"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path>
          <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path>
        </svg>
      </button>

    </div>
  )
}
