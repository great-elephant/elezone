import { SavedItem, BOOKMARK_COLORS, Settings, BookmarkColor } from '../shared/types'
import { useState } from 'react'

export default function Library({
  items,
  settings,
  onDelete,
  onUpdateColor
}: {
  items: SavedItem[]
  settings: Settings
  onDelete: (id: string) => void
  onUpdateColor: (id: string, color: BookmarkColor) => void
}) {
  const [expandedUrls, setExpandedUrls] = useState<Set<string>>(new Set())
  const [openColorPaletteId, setOpenColorPaletteId] = useState<string | null>(null)

  function toggleUrl(url: string) {
    const next = new Set(expandedUrls)
    if (next.has(url)) next.delete(url)
    else next.add(url)
    setExpandedUrls(next)
  }

  function playAudio(text: string) {
    if (!settings?.readAloud) return
    const r = settings.readAloud
    chrome.tts.stop()
    if (r.voice) {
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

  // Group items by URL
  const groups: Record<string, SavedItem[]> = {}
  for (const item of items) {
    const url = item.url || 'Dictionary (No URL)'
    if (!groups[url]) groups[url] = []
    groups[url].push(item)
  }

  const sortedUrls = Object.keys(groups).sort((a, b) => {
    // Sort by latest created item in each group
    const maxA = Math.max(...groups[a].map(i => i.createdAt))
    const maxB = Math.max(...groups[b].map(i => i.createdAt))
    return maxB - maxA
  })

  if (items.length === 0) {
    return (
      <div style={styles.empty}>
        <h3>Your library is empty</h3>
        <p>Highlight text and right-click to save sentences, or double-click words to save flashcards.</p>
      </div>
    )
  }

  return (
    <div style={styles.container}>
      <h2>My Library</h2>
      <div style={styles.list}>
        {sortedUrls.map(url => {
          const groupItems = groups[url]
          const isExpanded = expandedUrls.has(url)
          
          return (
            <div key={url} style={styles.group}>
              <div style={styles.groupHeader} onClick={() => toggleUrl(url)}>
                <div style={styles.groupHeaderLeft}>
                  <span style={styles.expander}>{isExpanded ? '▼' : '▶'}</span>
                  <a 
                    href={url} 
                    target="_blank" 
                    rel="noreferrer" 
                    style={styles.urlLink}
                    onClick={e => e.stopPropagation()}
                  >
                    {url}
                  </a>
                </div>
                <div style={styles.badge}>{groupItems.length} items</div>
              </div>
              
              {isExpanded && (
                <div style={styles.groupContent}>
                  {groupItems.map(item => (
                    <div key={item.id} style={styles.itemCard}>
                      <div style={styles.itemHeader}>
                        <div style={{ position: 'relative' }}>
                          <div 
                            style={{
                              ...styles.colorDot, 
                              backgroundColor: BOOKMARK_COLORS[item.color],
                              cursor: 'pointer'
                            }} 
                            onClick={() => setOpenColorPaletteId(openColorPaletteId === item.id ? null : item.id)}
                            title="Change color"
                          />
                          {openColorPaletteId === item.id && (
                            <div style={styles.colorPalette}>
                              {Object.entries(BOOKMARK_COLORS).map(([c, hex]) => (
                                <div 
                                  key={c}
                                  style={{
                                    width: 16, height: 16, borderRadius: '50%', background: hex, cursor: 'pointer',
                                    border: item.color === c ? '2px solid white' : '2px solid transparent'
                                  }}
                                  onClick={() => {
                                    onUpdateColor(item.id, c as BookmarkColor)
                                    setOpenColorPaletteId(null)
                                  }}
                                  title={c}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                        <div style={styles.date}>
                          {new Date(item.createdAt).toLocaleDateString()}
                        </div>
                        {item.translation && (
                          <div style={styles.flashcardBadge}>Flashcard</div>
                        )}
                        <button 
                          style={styles.deleteBtn}
                          onClick={() => onDelete(item.id)}
                        >
                          ✕
                        </button>
                      </div>
                      
                      <div style={styles.itemBody}>
                        {item.translation ? (
                          <>
                            <div style={styles.word}>
                              {item.text}
                              {item.phonetics && (
                                <span style={styles.phonetics}>{item.phonetics}</span>
                              )}
                              <button 
                                style={styles.speakerBtn} 
                                onClick={(e) => { e.stopPropagation(); playAudio(item.text) }}
                                title="Read word"
                              >
                                🔊
                              </button>
                            </div>
                            <div style={styles.translation}>{item.translation}</div>
                            {(item.prefix || item.suffix) && (
                              <div style={styles.context}>
                                {item.prefix}
                                <strong>{item.text}</strong>
                                {item.suffix}
                                <button 
                                  style={styles.speakerBtnSmall} 
                                  onClick={(e) => { e.stopPropagation(); playAudio((item.prefix || '') + item.text + (item.suffix || '')) }}
                                  title="Read sentence"
                                >
                                  🔊
                                </button>
                              </div>
                            )}
                          </>
                        ) : (
                          <div style={styles.quote}>
                            "{item.text}"
                            <button 
                              style={{...styles.speakerBtnSmall, marginLeft: 8}} 
                              onClick={(e) => { e.stopPropagation(); playAudio(item.text) }}
                              title="Read sentence"
                            >
                              🔊
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: 800,
    margin: '0 auto',
    padding: '20px 0'
  },
  empty: {
    textAlign: 'center',
    padding: '60px 20px',
    color: '#8888aa',
    background: '#1a1a2e',
    borderRadius: 12
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    marginTop: 20
  },
  group: {
    background: '#1a1a2e',
    borderRadius: 8,
    border: '1px solid #2a2a4a',
    overflow: 'hidden'
  },
  groupHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '16px 20px',
    cursor: 'pointer',
    background: '#111122',
  },
  groupHeaderLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    overflow: 'hidden'
  },
  expander: {
    color: '#666688',
    fontSize: 12
  },
  urlLink: {
    color: '#e0e0ff',
    textDecoration: 'none',
    fontWeight: 'bold',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: '500px'
  },
  badge: {
    background: '#2a2a4a',
    color: '#8888aa',
    padding: '4px 10px',
    borderRadius: 12,
    fontSize: 12,
    fontWeight: 'bold'
  },
  groupContent: {
    padding: '16px 20px',
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    borderTop: '1px solid #2a2a4a'
  },
  itemCard: {
    background: '#151525',
    border: '1px solid #2a2a4a',
    borderRadius: 8,
    padding: 16
  },
  itemHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    marginBottom: 12
  },
  colorDot: {
    width: 14,
    height: 14,
    borderRadius: '50%',
    transition: 'transform 0.1s'
  },
  colorPalette: {
    position: 'absolute',
    top: 20,
    left: 0,
    background: '#1a1a2e',
    border: '1px solid #3a3a6a',
    borderRadius: 8,
    padding: 8,
    display: 'flex',
    gap: 6,
    zIndex: 10,
    boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
    width: 'max-content'
  },
  date: {
    color: '#666688',
    fontSize: 12,
    flex: 1
  },
  flashcardBadge: {
    background: '#4a5a9a',
    color: '#ffffff',
    fontSize: 11,
    padding: '2px 8px',
    borderRadius: 4,
    fontWeight: 'bold'
  },
  deleteBtn: {
    background: 'none',
    border: 'none',
    color: '#ff6b6b',
    cursor: 'pointer',
    padding: 4
  },
  itemBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8
  },
  word: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#ffffff',
    display: 'flex',
    alignItems: 'baseline',
    gap: 8
  },
  phonetics: {
    fontSize: 14,
    fontWeight: 'normal',
    color: '#8888aa',
  },
  translation: {
    fontSize: 16,
    color: '#6bcfff'
  },
  context: {
    fontSize: 14,
    color: '#8888aa',
    fontStyle: 'italic',
    marginTop: 8
  },
  quote: {
    fontSize: 15,
    color: '#e0e0e0',
    lineHeight: 1.5,
    borderLeft: '3px solid #3a3a5a',
    paddingLeft: 12
  },
  speakerBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontSize: 16,
    padding: '0 4px',
    marginLeft: 8,
    opacity: 0.7,
  },
  speakerBtnSmall: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontSize: 14,
    padding: '0 4px',
    marginLeft: 4,
    opacity: 0.7,
  }
}
