import React, { useEffect, useState } from 'react';

const SLIDES_COUNT = 9;

export default function GuidePage() {
  const [currentSlide, setCurrentSlide] = useState(0);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') {
        setCurrentSlide(p => Math.min(p + 1, SLIDES_COUNT - 1));
      } else if (e.key === 'ArrowLeft') {
        setCurrentSlide(p => Math.max(p - 1, 0));
      }
    };

    let isWheeling = false;
    let wheelTimeout: ReturnType<typeof setTimeout>;

    const handleWheel = (e: WheelEvent) => {
      if (isWheeling) return;

      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;

      if (delta > 30) {
        isWheeling = true;
        setCurrentSlide(p => Math.min(p + 1, SLIDES_COUNT - 1));
        wheelTimeout = setTimeout(() => { isWheeling = false; }, 800);
      } else if (delta < -30) {
        isWheeling = true;
        setCurrentSlide(p => Math.max(p - 1, 0));
        wheelTimeout = setTimeout(() => { isWheeling = false; }, 800);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('wheel', handleWheel, { passive: true });
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('wheel', handleWheel);
      clearTimeout(wheelTimeout);
    };
  }, []);

  const goToSlide = (index: number) => {
    setCurrentSlide(Math.max(0, Math.min(index, SLIDES_COUNT - 1)));
  };

  return (
    <div style={styles.root}>
      <style>{`
        body {
          margin: 0;
          background-color: #0d0d1a !important;
          background-image: radial-gradient(rgba(255, 255, 255, 0.07) 1.5px, transparent 1.5px) !important;
          background-size: 24px 24px !important;
          font-family: system-ui, -apple-system, sans-serif;
          color: #fff;
          overflow: hidden;
        }
        .slider-track {
          display: flex;
          width: ${SLIDES_COUNT * 100}vw;
          height: 100vh;
          transition: transform 0.7s cubic-bezier(0.25, 1, 0.25, 1);
        }
        .slide {
          width: 100vw;
          height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 40px;
          box-sizing: border-box;
          position: relative;
        }
        .card {
          background: #111122;
          padding: 60px;
          border-radius: 24px;
          border: 1px solid #3a3a6a;
          box-shadow: 0 20px 40px rgba(0,0,0,0.4);
          max-width: 800px;
          width: 100%;
          display: flex;
          flex-direction: column;
          gap: 24px;
          position: relative;
          overflow: hidden;
        }
        .card::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          height: 4px;
          background: var(--glow-color);
          box-shadow: 0 0 20px var(--glow-color);
        }
        .instruction-box {
          margin-top: 8px;
          background: rgba(0, 0, 0, 0.25);
          border: 1px solid rgba(255, 255, 255, 0.05);
          padding: 16px 20px;
          border-radius: 12px;
          font-size: 1.05em;
          color: #c0c0e0;
          line-height: 1.5;
        }
        .icon {
          font-size: 4em;
          margin-bottom: 20px;
        }
        h2 {
          font-size: 2.5em;
          margin: 0;
          background: linear-gradient(90deg, #fff, #aab);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
        }
        p {
          font-size: 1.2em;
          color: #aab;
          line-height: 1.6;
          margin: 0;
        }
        
        .nav-btn {
          position: absolute;
          top: 50%;
          transform: translateY(-50%);
          background: rgba(255,255,255,0.1);
          border: none;
          color: white;
          width: 60px;
          height: 60px;
          border-radius: 30px;
          font-size: 24px;
          cursor: pointer;
          z-index: 10;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: background 0.2s;
        }
        .nav-btn:hover:not(:disabled) {
          background: rgba(255,255,255,0.2);
        }
        .nav-btn:disabled {
          opacity: 0.3;
          cursor: not-allowed;
        }
        
        .pagination {
          position: absolute;
          bottom: 40px;
          left: 50%;
          transform: translateX(-50%);
          display: flex;
          gap: 12px;
          z-index: 10;
        }
        .dot {
          width: 12px;
          height: 12px;
          border-radius: 6px;
          background: rgba(255,255,255,0.3);
          cursor: pointer;
          transition: all 0.3s;
        }
        .dot.active {
          width: 36px;
          background: #6bcfff;
          box-shadow: 0 0 10px rgba(107, 207, 255, 0.5);
        }
        
        .close-btn {
          position: absolute;
          top: 40px;
          right: 40px;
          background: #2a2a4a;
          color: #fff;
          border: none;
          padding: 10px 20px;
          border-radius: 8px;
          cursor: pointer;
          font-size: 1.1em;
          font-weight: bold;
          z-index: 20;
          transition: background 0.2s;
        }
        .close-btn:hover {
          background: #3a3a4a;
        }
        
        .breathing-ring {
          width: 80px; height: 80px;
          border-radius: 50%;
          border: 6px solid transparent;
          margin: 0 auto 20px;
          animation: 
            breatheScale 16s infinite linear,
            breatheColor 16s infinite step-end;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: bold;
          font-size: 16px;
          text-shadow: 0 0 10px rgba(0,0,0,0.8);
        }
        .breathing-ring::after {
          content: '';
          animation: breatheText 16s infinite step-end;
        }
        @keyframes breatheScale {
          0%   { transform: scale(0.5); opacity: 0.6; }
          25%  { transform: scale(1.1); opacity: 1; }
          50%  { transform: scale(1.1); opacity: 1; }
          75%  { transform: scale(0.5); opacity: 0.6; }
          100% { transform: scale(0.5); opacity: 0.6; }
        }
        @keyframes breatheColor {
          0%   { border-color: #4ade80; box-shadow: 0 0 20px #4ade80, inset 0 0 20px #4ade80; color: #4ade80; }
          25%  { border-color: #facc15; box-shadow: 0 0 20px #facc15, inset 0 0 20px #facc15; color: #facc15; }
          50%  { border-color: #60a5fa; box-shadow: 0 0 20px #60a5fa, inset 0 0 20px #60a5fa; color: #60a5fa; }
          75%  { border-color: #c084fc; box-shadow: 0 0 20px #c084fc, inset 0 0 20px #c084fc; color: #c084fc; }
          100% { border-color: #4ade80; box-shadow: 0 0 20px #4ade80, inset 0 0 20px #4ade80; color: #4ade80; }
        }
        @keyframes breatheText {
          0%   { content: 'Inhale'; }
          25%  { content: 'Hold'; }
          50%  { content: 'Exhale'; }
          75%  { content: 'Hold'; }
          100% { content: 'Inhale'; }
        }
      `}</style>

      {/* Top Right Close Button */}
      <button className="close-btn" onClick={() => window.close()}>
        ✕ Close
      </button>

      {/* Navigation */}
      {currentSlide > 0 && (
        <button
          className="nav-btn"
          style={{ left: 40 }}
          onClick={() => goToSlide(currentSlide - 1)}
        >
          ❮
        </button>
      )}
      {currentSlide < SLIDES_COUNT - 1 && (
        <button
          className="nav-btn"
          style={{ right: 40 }}
          onClick={() => goToSlide(currentSlide + 1)}
        >
          ❯
        </button>
      )}

      <div className="pagination">
        {Array.from({ length: SLIDES_COUNT }).map((_, i) => (
          <div
            key={i}
            className={`dot ${i === currentSlide ? 'active' : ''}`}
            onClick={() => goToSlide(i)}
            style={i === currentSlide ? { background: getSlideColor(i), boxShadow: `0 0 10px ${getSlideColor(i)}` } : {}}
          />
        ))}
      </div>

      <div className="slider-track" style={{ transform: `translateX(-${currentSlide * 100}vw)` }}>

        {/* Slide 0: Hero */}
        <div className="slide">
          <div style={{ display: 'flex', flexDirection: 'column', textAlign: 'center', gap: '30px', maxWidth: '800px' }}>
            <img src="/icons/icon128.png" alt="logo" style={{ width: 120, height: 120, margin: '0 auto', filter: 'drop-shadow(0 0 20px rgba(107, 207, 255, 0.5))' }} />
            <h1 style={{ fontSize: '4em', margin: 0, textShadow: '0 0 20px rgba(255,255,255,0.2)', lineHeight: 1.2 }}>HZone - The Ultimate<br />Learning Experience</h1>
            <p style={{ fontSize: '1.5em', margin: '0 auto' }}>Swipe through to discover how HZone transforms your daily web browsing into an effortless language learning journey.</p>
            <button
              onClick={() => goToSlide(1)}
              style={{ background: '#6bcfff', color: '#111', border: 'none', padding: '16px 32px', borderRadius: '30px', fontSize: '1.2em', fontWeight: 'bold', cursor: 'pointer', margin: '20px auto 0', width: 'fit-content', boxShadow: '0 0 20px rgba(107, 207, 255, 0.4)' }}
            >
              Start Tour ➔
            </button>
          </div>
        </div>

        {/* Slide 1: AI Dictionary */}
        <div className="slide">
          <div className="card" style={{ '--glow-color': '#6bcfff' } as React.CSSProperties}>
            <div className="icon">🤖</div>
            <h2>Context-Aware Translation</h2>
            <p>Standard dictionaries often give you the wrong meaning. Powered by on-device AI and smart context analysis, simply highlight any word to get a translation that understands the exact nuance of your current sentence. No more guessing—just precise, contextual understanding.</p>
            <div className="instruction-box">
              <strong>💡 How to use:</strong> Highlight any short text, right-click, and select a deck (e.g., "🔴 Red") to translate and save it.
            </div>
          </div>
        </div>

        {/* Slide 2: Screen OCR */}
        <div className="slide">
          <div className="card" style={{ '--glow-color': '#b36bff' } as React.CSSProperties}>
            <div className="icon">📸</div>
            <h2>Extract Words from Images</h2>
            <p>Reading a web manga or browsing social media? Don't let words trapped in images slow you down. Just bring up the right-click menu to launch our OCR tool, then seamlessly extract and translate the text. Turn your casual entertainment into a seamless learning experience.</p>
            <div className="instruction-box">
              <strong>💡 How to use:</strong> Right-click anywhere on the page or on an image and select "Image to text(OCR)".
            </div>
          </div>
        </div>

        {/* Slide 3: Immersive Read Aloud */}
        <div className="slide">
          <div className="card" style={{ '--glow-color': '#ff6bd6' } as React.CSSProperties}>
            <div className="icon">🎧</div>
            <h2>Immersive Read Aloud</h2>
            <p>Turn any English article into a listening practice session. HZone can read texts aloud with native pronunciation, highlighting each sentence as it speaks. Enable "Translation Aside" to instantly see translations right next to the active sentence, making comprehension effortless.</p>
            <div className="instruction-box">
              <strong>💡 How to use:</strong> Highlight a sentence, right-click, and select "Read from this sentence".
            </div>
          </div>
        </div>

        {/* Slide 4: Flashcards */}
        <div className="slide">
          <div className="card" style={{ '--glow-color': '#ffb36b' } as React.CSSProperties}>
            <div className="icon">🎴</div>
            <h2>Master Your Vocabulary</h2>
            <p>Saving words is only the beginning. HZone's built-in library offers four interactive study modes: Passive, Typing, Listening, and Multiple Choice. Dive into a session anytime to practice your saved words and lock them into your long-term memory.</p>
            <div className="instruction-box">
              <strong>💡 How to use:</strong> Open the Options page, go to the "Library" tab, and click the "Study" button.
            </div>
          </div>
        </div>

        {/* Slide 5: Notifications */}
        <div className="slide">
          <div className="card" style={{ '--glow-color': '#ffeb3b' } as React.CSSProperties}>
            <div className="icon">🔔</div>
            <h2>Learn Without Opening the App</h2>
            <p>Too busy to study? Our Spaced Repetition System (SRS) tracks when you're about to forget a word and sends a native system notification. Simply glance, guess the meaning, and click to reveal—all without interrupting your workflow.</p>
            <div className="instruction-box">
              <strong>💡 How to set up:</strong> Open the Options page, go to the "Settings" tab, and enable "Flashcard Notifications".
            </div>
          </div>
        </div>

        {/* Slide 6: Pomodoro & Box Breathing */}
        <div className="slide">
          <div className="card" style={{ '--glow-color': '#4ade80' } as React.CSSProperties}>
            <div className="breathing-ring" />
            <h2>Focus with Pomodoro & Box Breathing</h2>
            <p>HZone integrates a Pomodoro timer paired with Box Breathing techniques. Box breathing (inhale-hold-exhale-hold) is scientifically proven to reduce anxiety and lower heart rate, while Pomodoro helps you study in highly focused sprints for better memory retention.</p>
            <div className="instruction-box">
              <strong>💡 How to use:</strong> Open the extension popup, turn on "Breathe", and click "Start Focus" to begin a Pomodoro session.
            </div>
          </div>
        </div>

        {/* Slide 7: Gamification */}
        <div className="slide">
          <div className="card" style={{ '--glow-color': '#46ff6a' } as React.CSSProperties}>
            <div className="icon">🔥</div>
            <h2>Gamification & Roasts</h2>
            <p>Consistency is key, so we made it fun. Earn Sparks for every word you save or review, build your daily streak, and watch your activity heatmap light up. But be warned: if you start slacking off, the app won't hesitate to roast you!</p>
            <div className="instruction-box">
              <strong>💡 Where to find:</strong> Open the Options page and go to the "Dashboard" tab to view your Sparks and Level.
            </div>
          </div>
        </div>

        {/* Slide 8: Cloud Sync & Footer */}
        <div className="slide">
          <div className="card" style={{ '--glow-color': '#ff6b6b' } as React.CSSProperties}>
            <div className="icon">☁️</div>
            <h2>Secure Cloud Sync</h2>
            <p>Your data and learning progress belong to you. Everything—from your saved words to your daily streaks—is seamlessly synced to your personal Google Drive. Keep your journey safe, private, and accessible whenever you need it.</p>
            <div className="instruction-box">
              <strong>💡 How to set up:</strong> Open the Options page, go to the "Settings" tab, and enable "Auto-sync to Google Drive".
            </div>
            <div style={{ marginTop: '20px', borderTop: '1px solid #3a3a6a', paddingTop: '30px', textAlign: 'center' }}>
              <p style={{ marginBottom: '20px' }}>Ready to level up?</p>
              <button
                onClick={() => window.close()}
                style={{ background: '#ff6b6b', color: '#111', border: 'none', padding: '12px 32px', borderRadius: '8px', cursor: 'pointer', fontSize: '1.2em', fontWeight: 'bold', boxShadow: '0 0 15px rgba(255, 107, 107, 0.4)' }}
              >
                Return to Dashboard
              </button>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}

function getSlideColor(index: number) {
  switch (index) {
    case 0: return '#ffffff';
    case 1: return '#6bcfff';
    case 2: return '#b36bff';
    case 3: return '#ff6bd6';
    case 4: return '#ffb36b';
    case 5: return '#ffeb3b';
    case 6: return '#4ade80';
    case 7: return '#46ff6a';
    case 8: return '#ff6b6b';
    default: return '#6bcfff';
  }
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    width: '100vw',
    height: '100vh',
    position: 'relative',
    overflow: 'hidden'
  }
};
