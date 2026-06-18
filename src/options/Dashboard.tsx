import { useEffect, useState } from 'react'
import { ActivityLog, Settings, DEFAULT_SETTINGS } from '../shared/types'

function getLocalYMD(d: Date): string {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const LEVELS = [
  { maxXP: 0, title: 'Novice' },
  { maxXP: 50, title: 'Beginner' },
  { maxXP: 150, title: 'Learner' },
  { maxXP: 300, title: 'Scholar' },
  { maxXP: 600, title: 'Explorer' },
  { maxXP: 1000, title: 'Polyglot' },
  { maxXP: 2000, title: 'Linguist' },
  { maxXP: 5000, title: 'Master' },
  { maxXP: 10000, title: 'Grandmaster' }
]

function calculateLevel(xp: number) {
  let currentLevel = 1
  for (let i = 1; i < LEVELS.length; i++) {
    if (xp >= LEVELS[i].maxXP) {
      currentLevel = i + 1
    } else {
      break
    }
  }
  const currentTier = LEVELS[currentLevel - 1]
  const nextTier = LEVELS[currentLevel] || null
  return { currentLevel, title: currentTier.title, nextTier }
}

export default function Dashboard() {
  const [log, setLog] = useState<ActivityLog>({})
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [tooltip, setTooltip] = useState<{ visible: boolean, text: string, x: number, y: number }>({ visible: false, text: '', x: 0, y: 0 })

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_ACTIVITY_LOG' }, (res) => {
      if (res) setLog(res)
    })
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (s) => {
      if (s) setSettings(s)
    })
  }, [])

  const goal = settings.gamification?.dailyGoalPoints || 20
  const todayDate = new Date()
  const todayStr = getLocalYMD(todayDate)
  const todayPoints = log[todayStr]?.points || 0

  // Calculate Lifetime XP
  const lifetimeXP = Object.values(log).reduce((sum, day) => sum + (day.points || 0), 0)
  const { currentLevel, title, nextTier } = calculateLevel(lifetimeXP)

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
  while(iterDate.getDay() !== 0) {
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
    while(currentWeek.length < 7) currentWeek.push({ date: '', level: -1, points: 0 })
    weeks.push(currentWeek)
  }

  const getHeatmapColor = (level: number) => {
    switch(level) {
      case 1: return '#0e4429'
      case 2: return '#006d32'
      case 3: return '#26a641'
      case 4: return '#39d353'
      case -1: return 'transparent'
      default: return '#161b22'
    }
  }

  return (
    <div style={{ padding: '40px', color: '#fff', display: 'flex', justifyContent: 'center' }}>
      
      <style>{`
        .heatmap-square {
          position: relative;
        }
      `}</style>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '24px', width: '100%', maxWidth: '850px' }}>
        
        {/* Player Profile Banner */}
        <div style={{ gridColumn: '1 / -1', background: 'linear-gradient(135deg, #1e1e32 0%, #111122 100%)', padding: '30px', borderRadius: '16px', border: '1px solid #3a3a6a', display: 'flex', flexDirection: 'column', gap: '20px', boxShadow: '0 10px 30px rgba(0,0,0,0.3)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
            <div>
              <div style={{ fontSize: '0.9em', color: '#aaa', textTransform: 'uppercase', letterSpacing: '2px', marginBottom: '8px', fontWeight: 'bold' }}>Current Rank</div>
              <div style={{ fontSize: '2.2em', fontWeight: 'bold', color: '#fff', display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span style={{ fontSize: '1.2em', filter: 'drop-shadow(0 0 10px rgba(255,215,0,0.5))' }}>⭐</span>
                Level {currentLevel}: {title}
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '2em', fontWeight: 'bold', color: '#46ff6a', textShadow: '0 0 15px rgba(70,255,106,0.3)' }}>
                {lifetimeXP} <span style={{ fontSize: '0.5em', color: '#aaa', textTransform: 'uppercase', letterSpacing: '1px' }}>Lifetime XP</span>
              </div>
            </div>
          </div>

          {nextTier ? (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9em', color: '#ccc', marginBottom: '8px', fontWeight: 'bold' }}>
                <span>Progress to Level {currentLevel + 1} ({nextTier.title})</span>
                <span>{lifetimeXP} / {nextTier.maxXP} XP</span>
              </div>
              <div style={{ width: '100%', height: '14px', background: '#0d0d1a', borderRadius: '7px', overflow: 'hidden', border: '1px solid #2a2a4a', boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.5)' }}>
                <div style={{ height: '100%', width: `${Math.min(100, Math.max(0, ((lifetimeXP - LEVELS[currentLevel - 1].maxXP) / (nextTier.maxXP - LEVELS[currentLevel - 1].maxXP)) * 100))}%`, background: 'linear-gradient(90deg, #2ea043, #46ff6a)', borderRadius: '7px', transition: 'width 1.5s ease-in-out', boxShadow: '0 0 10px rgba(70,255,106,0.5)' }}></div>
              </div>
            </div>
          ) : (
            <div style={{ fontSize: '1.1em', color: '#39d353', fontWeight: 'bold', textAlign: 'center', marginTop: '10px' }}>
              🎉 Maximum Level Reached! You are a true Grandmaster!
            </div>
          )}
        </div>

        {/* Progress Ring Card */}
        <div style={{ background: '#111122', padding: '30px', borderRadius: '16px', border: '1px solid #3a3a6a', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', boxShadow: '0 10px 30px rgba(0,0,0,0.15)' }}>
          <div style={{ fontSize: '1.1em', color: '#ccc', marginBottom: '20px', fontWeight: 'bold', letterSpacing: '1px', textTransform: 'uppercase' }}>Daily Goal</div>
          <div style={{ position: 'relative', width: '160px', height: '160px', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
            <svg width="160" height="160" style={{ position: 'absolute', transform: 'rotate(-90deg)' }}>
              <circle cx="80" cy="80" r="70" stroke="#161b22" strokeWidth="14" fill="none" />
              <circle cx="80" cy="80" r="70" stroke="#39d353" strokeWidth="14" fill="none" 
                strokeDasharray={ringCircumference} strokeDashoffset={dashoffset} strokeLinecap="round" 
                style={{ transition: 'stroke-dashoffset 0.8s ease' }}/>
            </svg>
            <div style={{ textAlign: 'center', zIndex: 1 }}>
              <div style={{ fontSize: '2.5em', fontWeight: 'bold' }}>{todayPoints}</div>
              <div style={{ fontSize: '0.9em', color: '#aaa', fontWeight: 'bold' }}>/ {goal} pts</div>
            </div>
          </div>
        </div>

        {/* Streak Counter Card */}
        <div style={{ background: '#111122', padding: '30px', borderRadius: '16px', border: '1px solid #3a3a6a', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', boxShadow: '0 10px 30px rgba(0,0,0,0.15)' }}>
          <div style={{ fontSize: '4em', marginBottom: '10px' }}>🔥</div>
          <div style={{ fontSize: '3em', fontWeight: 'bold' }}>{streak}</div>
          <div style={{ color: '#aaa', fontWeight: 'bold', letterSpacing: '1px', textTransform: 'uppercase', fontSize: '0.9em' }}>Day Streak</div>
          <div style={{ marginTop: '15px', fontSize: '0.95em', color: hitToday ? '#39d353' : '#ffb36b', fontWeight: 'bold', lineHeight: '1.4', textAlign: 'center' }}>
            {hitToday 
              ? '✅ Daily goal reached! Streak extended.' 
              : `Earn ${goal - todayPoints} more pts today to extend!`}
          </div>
        </div>

        {/* Today's Breakdown */}
        <div style={{ gridColumn: '1 / -1', background: '#111122', padding: '20px 30px', borderRadius: '16px', border: '1px solid #3a3a6a', display: 'flex', justifyContent: 'space-around', boxShadow: '0 10px 30px rgba(0,0,0,0.15)' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '1.1em', color: '#ccc', marginBottom: '8px' }}>📖 Words Saved Today</div>
            <div style={{ fontSize: '2em', fontWeight: 'bold', color: '#6bcfff' }}>{log[todayStr]?.saved || 0}</div>
            <div style={{ fontSize: '0.9em', color: '#888' }}>+{settings.gamification?.pointsPerSave || 1} pt each</div>
          </div>
          <div style={{ width: '1px', background: '#3a3a6a' }}></div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '1.1em', color: '#ccc', marginBottom: '8px' }}>🧠 Cards Reviewed Today</div>
            <div style={{ fontSize: '2em', fontWeight: 'bold', color: '#ffb36b' }}>{log[todayStr]?.reviewed || 0}</div>
            <div style={{ fontSize: '0.9em', color: '#888' }}>+{settings.gamification?.pointsPerReview || 2} pts each</div>
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
                            setTooltip({ visible: true, text: `${day.points} pts on ${day.date}`, x: rect.left + rect.width / 2, y: rect.top })
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

    </div>
  )
}
