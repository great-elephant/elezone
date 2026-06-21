import { useEffect, useState } from "react";
import { ReadAloudState, Settings, DEFAULT_SETTINGS, PomodoroState, PomodoroSettings } from "../shared/types";

export default function Popup() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);

  const [readable, setReadable] = useState<boolean | null>(null);
  const [readAloudState, setReadAloudState] = useState<ReadAloudState>("idle");
  const [pomodoroState, setPomodoroState] = useState<PomodoroState | null>(null);

  useEffect(() => {
    let activeTabId: number | null = null;

    chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (s: Settings) => {
      if (s) setSettings(s);
    });
    chrome.runtime.sendMessage({ type: "GET_POMODORO_STATE" }, (res: PomodoroState) => {
      void chrome.runtime.lastError;
      if (res) setPomodoroState(res);
    });

    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab?.id || tab.id < 0) return;
      activeTabId = tab.id;
      chrome.runtime.sendMessage(
        { type: "GET_READ_ALOUD_STATE", payload: { tabId: tab.id } },
        (res: { state: ReadAloudState } | null) => {
          void chrome.runtime.lastError;
          setReadAloudState(res?.state ?? "idle");
        },
      );

      chrome.tabs.sendMessage(
        tab.id,
        { type: "CHECK_READABLE" },
        (res: { readable: boolean } | null) => {
          void chrome.runtime.lastError; // suppress "no receiving end" errors
          setReadable(res?.readable ?? true); // if unreachable, assume readable and let user try
        },
      );
    });

    const listener = (
      msg: { type: string; payload?: unknown },
      _sender: chrome.runtime.MessageSender,
    ) => {
      if (msg.type === "READ_ALOUD_STATE") {
        const payload = msg.payload as
          | { tabId?: number; state?: ReadAloudState }
          | undefined;
        if (payload?.tabId === activeTabId && payload.state) {
          setReadAloudState(payload.state);
        }
      } else if (msg.type === "POMODORO_STATE_UPDATE") {
        setPomodoroState(msg.payload as PomodoroState);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  async function toggleTranslation() {
    const next: Settings = {
      ...settings,
      translation: {
        ...settings.translation,
        enabled: !settings.translation.enabled,
      },
    };
    setSettings(next);
    await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", payload: next });
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (tab?.id && tab.id >= 0) {
      chrome.tabs
        .sendMessage(tab.id, {
          type: "TOGGLE_TRANSLATION",
          payload: { enabled: next.translation.enabled },
        })
        .catch(() => { });
    }
  }

  async function startReadAloud() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab?.id && tab.id >= 0)
        chrome.tabs
          .sendMessage(tab.id, { type: "START_READ_ALOUD" })
          .catch(() => { });
    });
  }

  function controlReadAloud(action: 'pause' | 'resume' | 'stop') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab?.id && tab.id >= 0) {
        chrome.runtime
          .sendMessage({ type: "CONTROL_READ_ALOUD", payload: { action, tabId: tab.id } })
          .catch(() => { });
      }
    });
  }

  async function openDashboard() {
    await chrome.runtime.openOptionsPage();
    window.close();
  }

  async function openGuide() {
    window.open(chrome.runtime.getURL("src/options/guide.html"));
    window.close();
  }

  function sendPomodoroCmd(action: string) {
    chrome.runtime.sendMessage({ type: "POMODORO_COMMAND", payload: { action, settings: settings.pomodoro || DEFAULT_SETTINGS.pomodoro } }, (res: PomodoroState) => {
      void chrome.runtime.lastError;
      if (res) setPomodoroState(res);
    });
  }

  async function toggleBreathing() {
    const next: Settings = {
      ...settings,
      pomodoro: {
        ...(settings.pomodoro || DEFAULT_SETTINGS.pomodoro),
        breathingEnabled: !(settings.pomodoro?.breathingEnabled ?? true),
      } as PomodoroSettings,
    };
    setSettings(next);
    await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", payload: next });

    chrome.runtime.sendMessage({
      type: "POMODORO_COMMAND",
      payload: { action: 'updateSettings', settings: next.pomodoro }
    });
  }

  const startDisabled = readable === false;

  const ocrLangMap: Record<string, string> = {
    eng: 'EN',
    chi_sim: 'ZH-S',
    chi_tra: 'ZH-T'
  };
  const displayLang = settings.ocr?.language ? (ocrLangMap[settings.ocr.language] || settings.ocr.language.toUpperCase()) : 'EN'; return (
    <div style={styles.container}>
      <style>{`
        .premium-start-btn {
          background: #4f6ef7;
          color: #fff;
          border: 1px solid transparent;
          border-radius: 8px;
          padding: 10px 0;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          width: 100%;
          transition: background 0.2s, border-color 0.2s;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
        }
        .premium-start-btn:hover:not(:disabled) {
          background: #3b5bdb;
          border-color: #5b79ff;
        }
        .premium-start-btn:active:not(:disabled) {
          background: #2d4fd4;
        }
        .premium-start-btn:disabled {
          background: #2a2a4a;
          color: #666688;
          cursor: not-allowed;
        }
      `}</style>
      <header style={styles.header}>
        <span style={styles.logo}>
          <img
            src="/icons/icon32.png"
            alt="logo"
            style={{ width: "20px", height: "20px", display: "block" }}
          />
        </span>
        <span style={styles.title}>EleZone</span>
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          marginLeft: 'auto'
        }}>
          <button
            onClick={() => {
              chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
                if (tabs[0]?.id) {
                  chrome.tabs.sendMessage(tabs[0].id, { type: 'START_CROP_MODE' }).catch(() => { });
                }
              });
              window.close();
            }}
            style={{
              marginLeft: 'auto',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: '#8888aa',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 4
            }}
            onMouseEnter={e => e.currentTarget.style.color = '#4ade80'}
            onMouseLeave={e => e.currentTarget.style.color = '#8888aa'}
            title={`Image to Text (OCR) [${displayLang}] - Alt+O`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
              <circle cx="8.5" cy="8.5" r="1.5"></circle>
              <polyline points="21 15 16 10 5 21"></polyline>
            </svg>
          </button>
          <button
            onClick={openGuide}
            style={{
              marginLeft: 4,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: '#8888aa',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 4
            }}
            onMouseEnter={e => e.currentTarget.style.color = '#c0c0e0'}
            onMouseLeave={e => e.currentTarget.style.color = '#8888aa'}
            title="View Feature Guide"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path>
              <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path>
            </svg>
          </button>
        </div>
      </header>

      <div style={styles.body}>

        {/* Pomodoro Section */}
        <div style={styles.pomodoroBox}>
          <div style={styles.pomodoroHeader}>
            <span>Pomodoro</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11, color: '#8888aa', fontWeight: 'normal' }}>Breathe</span>
              <button
                style={{
                  ...styles.toggle,
                  ...(settings.pomodoro?.breathingEnabled !== false ? styles.toggleOn : {}),
                }}
                onClick={toggleBreathing}
              >
                <span
                  style={{
                    ...styles.toggleThumb,
                    ...(settings.pomodoro?.breathingEnabled !== false ? styles.toggleThumbOn : {}),
                  }}
                />
              </button>
            </div>
          </div>
          <div style={{ fontSize: 11, color: '#666688', marginTop: -6, marginBottom: 8, lineHeight: 1.4 }}>
            Stay focused with Pomodoro timer & Box Breathing.
          </div>

          {pomodoroState && pomodoroState.phase !== 'idle' ? (
            <div style={styles.pomodoroDisplay}>
              <div style={styles.pomodoroPhaseTitle}>
                {pomodoroState.phase === 'focus' ? 'Focus Session' : pomodoroState.phase === 'shortBreak' ? 'Short Break' : 'Long Break'}
              </div>
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 120, height: 120, margin: '4px auto' }}>
                <BreathingRing state={pomodoroState} settings={settings.pomodoro || DEFAULT_SETTINGS.pomodoro!} />
                <div style={{ ...styles.pomodoroTime, margin: 0, fontSize: 30 }}>
                  {Math.floor(pomodoroState.timeRemaining / 60).toString().padStart(2, '0')}:{(pomodoroState.timeRemaining % 60).toString().padStart(2, '0')}
                </div>
              </div>
              <div style={styles.pomodoroControls}>
                {pomodoroState.status === 'running' ? (
                  <button style={styles.pomodoroBtn} onClick={() => sendPomodoroCmd('pause')}>Pause</button>
                ) : (
                  <button style={styles.pomodoroBtn} onClick={() => sendPomodoroCmd('resume')}>Resume</button>
                )}
                <button style={styles.pomodoroBtnSecondary} onClick={() => sendPomodoroCmd('stop')}>Stop</button>
              </div>
            </div>
          ) : (
            <div style={styles.pomodoroControls}>
              <button className="premium-start-btn" onClick={() => sendPomodoroCmd('startFocus')}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                Start Focus
              </button>
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
            <span style={{ fontSize: 11, color: '#8888aa', width: 45 }}>Volume</span>
            <input
              type="range"
              min="0"
              max="2"
              step="0.05"
              value={settings.pomodoro?.volume ?? 1}
              onChange={(e) => {
                const vol = parseFloat(e.target.value);
                const newSettings = { ...settings, updatedAt: Date.now(), pomodoro: { ...settings.pomodoro!, volume: vol } };
                setSettings(newSettings);
                chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", payload: newSettings });
                chrome.runtime.sendMessage({ type: "POMODORO_COMMAND", payload: { action: 'updateSettings', settings: newSettings.pomodoro } });
              }}
              style={{ flex: 1, accentColor: '#4ade80', height: 4 }}
            />
            <span style={{ fontSize: 11, color: '#8888aa', width: 40, textAlign: 'right' }}>
              {Math.round(((settings.pomodoro?.volume ?? 1) / 2) * 100)}%
            </span>
          </div>
        </div>

        <div style={styles.pomodoroBox}>
          <div style={styles.pomodoroHeader}>
            <span>Page Read Aloud</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11, color: '#8888aa', fontWeight: 'normal' }}>Translate</span>
              <button
                style={{
                  ...styles.toggle,
                  ...(settings.translation.enabled ? styles.toggleOn : {}),
                }}
                onClick={toggleTranslation}
                aria-pressed={settings.translation.enabled}
              >
                <span
                  style={{
                    ...styles.toggleThumb,
                    ...(settings.translation.enabled ? styles.toggleThumbOn : {}),
                  }}
                />
              </button>
            </div>
          </div>
          <div style={{ fontSize: 11, color: '#666688', marginTop: -6, marginBottom: 8, lineHeight: 1.4 }}>
            Read aloud and translate text on the fly.
          </div>

          {readAloudState === 'idle' ? (
            <button
              className="premium-start-btn"
              onClick={startReadAloud}
              disabled={startDisabled}
              title={startDisabled ? "No readable content found on this page" : ""}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
              Start Reading
            </button>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#2d4fd4', borderRadius: 8, padding: '8px 12px' }}>
              <span style={{ fontSize: 13, color: '#fff', fontWeight: 600, flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: 3, backgroundColor: readAloudState === 'playing' ? '#4ade80' : '#facc15' }} />
                {readAloudState === 'playing' ? 'Reading...' : 'Paused'}
              </span>
              {readAloudState === 'playing' ? (
                <button style={{ background: 'rgba(255,255,255,0.2)', border: 'none', color: '#fff', padding: '4px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600 }} onClick={() => controlReadAloud('pause')}>Pause</button>
              ) : (
                <button style={{ background: 'rgba(255,255,255,0.2)', border: 'none', color: '#fff', padding: '4px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600 }} onClick={() => controlReadAloud('resume')}>Resume</button>
              )}
              <button style={{ background: 'rgba(255,100,100,0.5)', border: 'none', color: '#fff', padding: '4px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600 }} onClick={() => controlReadAloud('stop')}>Stop</button>
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
            <span style={{ fontSize: 11, color: '#8888aa', width: 45 }}>Volume</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={settings.readAloud?.volume ?? 1}
              onChange={(e) => {
                const vol = parseFloat(e.target.value);
                const newSettings = { ...settings, updatedAt: Date.now(), readAloud: { ...settings.readAloud, volume: vol } };
                setSettings(newSettings);
                chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", payload: newSettings });
              }}
              style={{ flex: 1, accentColor: '#4ade80', height: 4 }}
            />
            <span style={{ fontSize: 11, color: '#8888aa', width: 32, textAlign: 'right' }}>
              {Math.round((settings.readAloud?.volume ?? 1) * 100)}%
            </span>
          </div>
        </div>

        <button style={styles.dashboardBtn} onClick={openDashboard}>
          Open Dashboard ↗
        </button>
      </div>
    </div>
  );
}

function BreathingRing({ state, settings }: { state: PomodoroState, settings: PomodoroSettings }) {
  const [progress, setProgress] = useState({ currentPhaseIdx: 0, phaseProgress: 0, activePhases: [] as any[] });

  useEffect(() => {
    if (state.status !== 'running' || settings.breathingEnabled === false || !state.breathStartTime) return;

    let frameId: number;
    const i = settings.inhale ?? 8;
    const h1 = settings.hold1 ?? 4;
    const e = settings.exhale ?? 8;
    const h2 = settings.hold2 ?? 4;
    const totalCycle = i + h1 + e + h2;

    const activePhases: { type: string, duration: number, color: string }[] = [];
    if (i > 0) activePhases.push({ type: 'inhale', duration: i, color: '#4ade80' });
    if (h1 > 0) activePhases.push({ type: 'hold1', duration: h1, color: '#facc15' });
    if (e > 0) activePhases.push({ type: 'exhale', duration: e, color: '#60a5fa' });
    if (h2 > 0) activePhases.push({ type: 'hold2', duration: h2, color: '#c084fc' });

    const numSegments = activePhases.length;
    if (numSegments === 0) return;

    function loop() {
      const elapsed = (Date.now() - state.breathStartTime!) / 1000;
      const cycleTime = elapsed % totalCycle;

      let currentPhaseIdx = 0;
      let phaseProgress = 0;
      let accumulatedTime = 0;

      for (let idx = 0; idx < numSegments; idx++) {
        const phase = activePhases[idx];
        if (cycleTime < accumulatedTime + phase.duration) {
          currentPhaseIdx = idx;
          phaseProgress = (cycleTime - accumulatedTime) / phase.duration;
          break;
        }
        accumulatedTime += phase.duration;
      }

      setProgress({ currentPhaseIdx, phaseProgress, activePhases });
      frameId = requestAnimationFrame(loop);
    }
    frameId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frameId);
  }, [state.status, state.breathStartTime, settings]);

  if (settings.breathingEnabled === false || state.status !== 'running' || !state.breathStartTime || progress.activePhases.length === 0) {
    return null;
  }

  const radius = 54;
  const strokeWidth = 6;
  const normalizedRadius = radius - strokeWidth / 2;
  const circumference = normalizedRadius * 2 * Math.PI;
  const totalCycleDuration = progress.activePhases.reduce((acc, p) => acc + p.duration, 0);

  return (
    <svg width={112} height={112} style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%) rotate(-90deg)', pointerEvents: 'none' }}>
      <circle cx="56" cy="56" r={normalizedRadius} fill="transparent" stroke="#2a2a4a" strokeWidth={strokeWidth} />

      {progress.activePhases.map((phase, k) => {
        if (k > progress.currentPhaseIdx) return null;

        let accumulatedDuration = 0;
        for (let i = 0; i < k; i++) accumulatedDuration += progress.activePhases[i].duration;

        const rotateAngle = (accumulatedDuration / totalCycleDuration) * 360;

        let lengthRatio = 0;
        if (k < progress.currentPhaseIdx) {
          lengthRatio = phase.duration / totalCycleDuration;
        } else {
          lengthRatio = (phase.duration / totalCycleDuration) * progress.phaseProgress;
        }

        const currentLength = lengthRatio * circumference;
        const strokeDashoffset = circumference - currentLength;

        return (
          <circle
            key={k}
            cx="56" cy="56" r={normalizedRadius} fill="transparent"
            stroke={phase.color} strokeWidth={strokeWidth}
            strokeDasharray={circumference} strokeDashoffset={strokeDashoffset}
            style={{ transformOrigin: '56px 56px', transform: `rotate(${rotateAngle}deg)` }}
          />
        )
      })}
    </svg>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: "flex", flexDirection: "column", minHeight: 160 },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "12px 16px 10px",
    borderBottom: "1px solid #2a2a4a",
  },
  logo: { fontSize: 20 },
  title: { fontSize: 15, fontWeight: 600, letterSpacing: 0.3 },
  body: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    padding: "14px 16px 16px",
  },
  primaryBtn: {
    background: "#4f6ef7",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "9px 0",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    width: "100%",
  },
  primaryBtnActive: { background: "#2d4fd4" },
  btnDisabled: { opacity: 0.4, cursor: "not-allowed", background: "#3a3a6a" },
  toggleRow: { display: "flex", alignItems: "center", gap: 10 },
  toggleLabelGroup: { flex: 1, display: "flex", alignItems: "center", gap: 6 },
  toggleLabel: { fontSize: 13, color: "#c0c0d0" },
  sourceChip: {
    fontSize: 10,
    color: "#6688aa",
    background: "#1a2030",
    borderRadius: 4,
    padding: "2px 5px",
  },
  toggle: {
    position: "relative",
    width: 38,
    height: 22,
    borderRadius: 11,
    background: "#3a3a5a",
    border: "none",
    cursor: "pointer",
    padding: 0,
    flexShrink: 0,
    transition: "background 0.2s",
  },
  toggleOn: { background: "#4f6ef7" },
  toggleThumb: {
    position: "absolute",
    top: 3,
    left: 3,
    width: 16,
    height: 16,
    borderRadius: "50%",
    background: "#fff",
    transition: "left 0.2s",
  },
  toggleThumbOn: { left: 19 },
  dashboardBtn: {
    background: "transparent",
    border: "1px solid #3a3a5a",
    color: "#8888cc",
    borderRadius: 8,
    padding: "7px 0",
    fontSize: 13,
    cursor: "pointer",
    width: "100%",
  },
  pomodoroBox: {
    background: "#1a1a2e",
    border: "1px solid #2a2a4a",
    borderRadius: 8,
    padding: "10px 12px",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  pomodoroHeader: {
    fontSize: 13,
    fontWeight: 600,
    color: "#c0c0e0",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center"
  },
  pomodoroActiveBadge: {
    fontSize: 10,
    background: "#4f6ef7",
    color: "#fff",
    padding: "2px 6px",
    borderRadius: 10,
    textTransform: "uppercase"
  },
  pomodoroDisplay: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 6
  },
  pomodoroPhaseTitle: {
    fontSize: 12,
    color: "#8888aa"
  },
  pomodoroTime: {
    fontSize: 28,
    fontWeight: "bold",
    color: "#fff",
    fontFamily: "monospace",
    letterSpacing: 2
  },
  pomodoroControls: {
    display: "flex",
    gap: 8,
    width: "100%",
    marginTop: 4
  },
  pomodoroBtnPrimary: {
    flex: 2,
    background: "#4f6ef7",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "6px 0",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  pomodoroBtn: {
    flex: 1,
    background: "#3a3a5a",
    color: "#e0e0e0",
    border: "none",
    borderRadius: 6,
    padding: "6px 0",
    fontSize: 13,
    cursor: "pointer",
  },
  pomodoroBtnSecondary: {
    flex: 1,
    background: "transparent",
    color: "#8888aa",
    border: "1px solid #3a3a5a",
    borderRadius: 6,
    padding: "5px 0",
    fontSize: 13,
    cursor: "pointer",
  }
};
