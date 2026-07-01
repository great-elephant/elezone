import { useEffect, useState, useRef } from "react";
import { ReadAloudState, Settings, DEFAULT_SETTINGS, PomodoroState, PomodoroSettings, TodoTask } from "../shared/types";
import { PomodoroTodoList } from "./components/PomodoroTodoList";

function formatTime(seconds?: number): string | null {
  if (!seconds) return null;
  if (seconds < 60) return '<1m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function Popup() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);

  const [readable, setReadable] = useState<boolean | null>(null);
  // Coarse on-device AI translation status for the active tab.
  // null → not on a page where the content script runs (show nothing / neutral).
  const [translatorStatus, setTranslatorStatus] = useState<
    "available" | "downloading" | "unavailable" | null
  >(null);
  const [readAloudState, setReadAloudState] = useState<ReadAloudState>("idle");
  const [pomodoroState, setPomodoroState] = useState<PomodoroState | null>(null);
  const [showTodoList, setShowTodoList] = useState(false);
  const [showVolumeSlider, setShowVolumeSlider] = useState(false);
  const [showReadAloudVolumeSlider, setShowReadAloudVolumeSlider] = useState(false);
  const todoListRef = useRef<HTMLDivElement>(null);
  const volumeControlRef = useRef<HTMLDivElement>(null);
  const readAloudVolumeControlRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (volumeControlRef.current && !volumeControlRef.current.contains(event.target as Node)) {
        setShowVolumeSlider(false);
      }
      if (readAloudVolumeControlRef.current && !readAloudVolumeControlRef.current.contains(event.target as Node)) {
        setShowReadAloudVolumeSlider(false);
      }
    }
    if (showVolumeSlider || showReadAloudVolumeSlider) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showVolumeSlider, showReadAloudVolumeSlider]);

  useEffect(() => {
    if (pomodoroState && pomodoroState.phase !== 'idle') {
      setShowTodoList(false);
    }
  }, [pomodoroState?.phase]);

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

      chrome.tabs.sendMessage(
        tab.id,
        { type: "GET_TRANSLATOR_STATUS" },
        (res: { status: "available" | "downloading" | "unavailable" } | null) => {
          void chrome.runtime.lastError; // suppress "no receiving end" errors
          // On chrome://, extension, or non-injected pages there is no receiver:
          // leave status null so the badge shows a neutral "unavailable on this page".
          setTranslatorStatus(res?.status ?? null);
        },
      );
    });

    const handleStorageChange = (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => {
      if (areaName === 'local' && changes['settings']) {
        setSettings(changes['settings'].newValue as Settings);
      }
    };
    chrome.storage.onChanged.addListener(handleStorageChange);

    const handleMessage = (
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
    chrome.runtime.onMessage.addListener(handleMessage);
    return () => {
      chrome.runtime.onMessage.removeListener(handleMessage);
      chrome.storage.onChanged.removeListener(handleStorageChange);
    };
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

  function sendPomodoroCmd(action: string, taskId?: string) {
    chrome.runtime.sendMessage({ type: "POMODORO_COMMAND", payload: { action, taskId, settings: settings.pomodoro || DEFAULT_SETTINGS.pomodoro } }, (res: PomodoroState) => {
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

  function handleTasksChange(newTasks: TodoTask[]) {
    const next: Settings = { ...settings, tasks: newTasks, updatedAt: Date.now() };
    setSettings(next);
    chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", payload: next });
  }

  function handleDoneTasksChange(newDoneTasks: TodoTask[]) {
    const next: Settings = { ...settings, doneTasks: newDoneTasks, updatedAt: Date.now() };
    setSettings(next);
    chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", payload: next });
  }

  function handleDailyTasksChange(newDailyTasks: TodoTask[]) {
    const next: Settings = { ...settings, dailyTasks: newDailyTasks, updatedAt: Date.now() };
    setSettings(next);
    chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", payload: next });
  }

  function handleCompleteTask(taskId: string) {
    if (!settings.tasks) return;
    const taskToComplete = settings.tasks.find(t => t.id === taskId);
    if (!taskToComplete) return;

    const newTasks = settings.tasks.filter(t => t.id !== taskId);

    // Add to top of done tasks
    const completedTask = { ...taskToComplete, completedAt: Date.now() };
    const newDoneTasks = [completedTask, ...(settings.doneTasks || [])];

    const next: Settings = { ...settings, tasks: newTasks, doneTasks: newDoneTasks, updatedAt: Date.now() };
    setSettings(next);
    chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", payload: next });
  }

  function handleCompleteActiveTask() {
    if (pomodoroState?.activeTaskId) {
      handleCompleteTask(pomodoroState.activeTaskId);
    }
  }

  function handleRevertTask(taskId: string) {
    if (!settings.doneTasks) return;
    const taskToRevert = settings.doneTasks.find(t => t.id === taskId);
    if (!taskToRevert) return;

    const newDoneTasks = settings.doneTasks.filter(t => t.id !== taskId);
    const newTasks = [taskToRevert, ...(settings.tasks || [])];

    const next: Settings = { ...settings, tasks: newTasks, doneTasks: newDoneTasks, updatedAt: Date.now() };
    setSettings(next);
    chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", payload: next });
  }

  function handleStartFocusTask(taskId: string) {
    if (!settings.tasks) return;
    const taskIndex = settings.tasks.findIndex(t => t.id === taskId);
    if (taskIndex > -1) {
      const taskToFocus = settings.tasks[taskIndex];
      const newTasks = [...settings.tasks];
      newTasks.splice(taskIndex, 1);
      newTasks.unshift(taskToFocus);

      const next: Settings = { ...settings, tasks: newTasks, updatedAt: Date.now() };
      setSettings(next);
      chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", payload: next });

      if (!pomodoroState || pomodoroState.phase === 'idle') {
        sendPomodoroCmd('startFocus', taskId);
      }
      setShowTodoList(false);
    }
  }

  const activeTask = settings.tasks?.find(t => t.id === pomodoroState?.activeTaskId);

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
          color: #8a8ab0;
          cursor: not-allowed;
        }
        button:focus-visible,
        input:focus-visible,
        [role="switch"]:focus-visible {
          outline: 2px solid #4f6ef7;
          outline-offset: 2px;
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
            aria-label={`Image to Text (OCR) [${displayLang}] - Alt+O`}
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
            aria-label="View Feature Guide"
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
            <span>Focus Zone</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11, color: '#8888aa', fontWeight: 'normal' }}>Breathe</span>
              <button
                style={{
                  ...styles.toggle,
                  ...(settings.pomodoro?.breathingEnabled !== false ? styles.toggleOn : {}),
                }}
                onClick={toggleBreathing}
                role="switch"
                aria-label="Box breathing animation"
                aria-pressed={settings.pomodoro?.breathingEnabled !== false}
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
          <div style={{ fontSize: 11, color: '#8a8ab0', marginTop: -6, marginBottom: 8, lineHeight: 1.4 }}>
            Stay focused with Pomodoro timer & Box Breathing.
          </div>

          {pomodoroState && pomodoroState.phase !== 'idle' ? (
            <div style={{ ...styles.pomodoroDisplay, position: 'relative' }}>
              <div style={styles.pomodoroPhaseTitle}>
                {pomodoroState.phase === 'focus' ? 'Focus Session' : pomodoroState.phase === 'shortBreak' ? 'Short Break' : 'Long Break'}
              </div>
              {pomodoroState.phase === 'focus' && activeTask && (
                <div style={{ ...styles.activeTaskRow, alignItems: 'flex-start' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', overflow: 'hidden', flex: 1 }} title={activeTask.text}>
                    <span style={{ ...styles.activeTaskName, lineHeight: '16px' }}>{activeTask.text}</span>
                    {activeTask.timeSpentSeconds ? (
                      <span style={{ fontSize: 10, color: '#4ade80', fontWeight: 'bold', flexShrink: 0, background: 'rgba(74, 222, 128, 0.15)', padding: '2px 6px', borderRadius: '4px' }}>
                        {formatTime(activeTask.timeSpentSeconds)}
                      </span>
                    ) : null}
                  </div>
                  <button
                    onClick={handleCompleteActiveTask}
                    style={{ background: 'none', border: 'none', color: '#8888aa', cursor: 'pointer', padding: '0', display: 'flex', alignItems: 'center', borderRadius: '4px', flexShrink: 0, height: '16px' }}
                    title="Mark as Done"
                    aria-label="Mark task as done"
                    onMouseEnter={(e) => (e.currentTarget.style.color = '#4ade80')}
                    onMouseLeave={(e) => (e.currentTarget.style.color = '#8888aa')}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                  </button>
                </div>
              )}
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: 120, margin: '4px auto' }}>
                <BreathingRing state={pomodoroState} settings={settings.pomodoro || DEFAULT_SETTINGS.pomodoro!} />
                <div style={{ ...styles.pomodoroTime, margin: 0 }}>
                  {Math.floor(pomodoroState.timeRemaining / 60).toString().padStart(2, '0')}:{(pomodoroState.timeRemaining % 60).toString().padStart(2, '0')}
                </div>

                {/* Volume Control */}
                <div
                  ref={volumeControlRef}
                  style={{ position: 'absolute', top: 0, right: 0, zIndex: 10, display: 'flex', flexDirection: 'column', alignItems: 'center' }}
                  onWheel={(e) => {
                    if (!showVolumeSlider) return;
                    e.preventDefault();
                    const step = 0.05;
                    const direction = e.deltaY < 0 ? 1 : -1;
                    const vol = settings.pomodoro?.volume ?? 1;
                    let newVol = vol + (direction * step);
                    newVol = Math.max(0, Math.min(2, newVol));

                    const newSettings = { ...settings, updatedAt: Date.now(), pomodoro: { ...settings.pomodoro!, volume: newVol } };
                    setSettings(newSettings);
                    chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", payload: newSettings });
                    chrome.runtime.sendMessage({ type: "POMODORO_COMMAND", payload: { action: 'updateSettings', settings: newSettings.pomodoro } });
                  }}
                >
                  <button
                    onClick={() => setShowVolumeSlider(!showVolumeSlider)}
                    style={{ background: '#2a2a4a', border: '1px solid #3a3a5a', borderRadius: '50%', color: '#8888aa', cursor: 'pointer', padding: 6, display: 'flex', transition: 'color 0.2s', boxShadow: '0 2px 4px rgba(0,0,0,0.2)' }}
                    onMouseEnter={e => e.currentTarget.style.color = '#fff'}
                    onMouseLeave={e => e.currentTarget.style.color = '#8888aa'}
                    title={`Volume: ${Math.round(((settings.pomodoro?.volume ?? 1) / 2) * 100)}%`}
                    aria-label={`Timer sound volume: ${Math.round(((settings.pomodoro?.volume ?? 1) / 2) * 100)}%`}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                      {(settings.pomodoro?.volume ?? 1) === 0 ? (
                        <>
                          <line x1="23" y1="9" x2="17" y2="15"></line>
                          <line x1="17" y1="9" x2="23" y2="15"></line>
                        </>
                      ) : (
                        <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                      )}
                    </svg>
                  </button>
                  {showVolumeSlider && (
                    <div style={{ position: 'absolute', top: '100%', marginTop: 8, left: '50%', transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                      <input
                        autoFocus
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
                        style={{ accentColor: '#4ade80', height: 60, width: 8, margin: 0, writingMode: 'vertical-lr', direction: 'rtl' }}
                      />
                      <span style={{ fontSize: 10, color: '#8888aa', fontWeight: 'bold', width: '28px', textAlign: 'center' }}>
                        {Math.round(((settings.pomodoro?.volume ?? 1) / 2) * 100)}%
                      </span>
                    </div>
                  )}
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
            <>
              <div ref={todoListRef}>
                <div style={styles.pomodoroControls}>
                  <button
                    style={{ ...styles.pomodoroBtnSecondary, flex: '0 0 40px', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}
                    onClick={() => setShowTodoList(!showTodoList)}
                    title={settings.tasks && settings.tasks.length > 0 ? settings.tasks[0].text : "Todo List"}
                    aria-label="Toggle todo list"
                    aria-expanded={showTodoList}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="8" y1="6" x2="21" y2="6"></line>
                      <line x1="8" y1="12" x2="21" y2="12"></line>
                      <line x1="8" y1="18" x2="21" y2="18"></line>
                      <line x1="3" y1="6" x2="3.01" y2="6"></line>
                      <line x1="3" y1="12" x2="3.01" y2="12"></line>
                      <line x1="3" y1="18" x2="3.01" y2="18"></line>
                    </svg>
                    {settings.tasks && settings.tasks.length > 0 && (
                      <span style={{ position: 'absolute', top: -5, right: -5, background: '#4ade80', color: '#1a1a2e', fontSize: 9, fontWeight: 'bold', padding: '2px 4px', borderRadius: 10 }}>{settings.tasks.length}</span>
                    )}
                  </button>
                  <button className="premium-start-btn" onClick={() => sendPomodoroCmd('startFocus')}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                    Start Focus
                  </button>
                </div>
                {showTodoList && (
                  <div style={{ position: 'relative', marginTop: 8 }}>
                    <PomodoroTodoList
                      tasks={settings.tasks || []}
                      doneTasks={settings.doneTasks || []}
                      dailyTasks={settings.dailyTasks || []}
                      onTasksChange={handleTasksChange}
                      onDoneTasksChange={handleDoneTasksChange}
                      onDailyTasksChange={handleDailyTasksChange}
                      onCompleteTask={handleCompleteTask}
                      onRevertTask={handleRevertTask}
                      onStartFocus={handleStartFocusTask}
                    />
                  </div>
                )}
              </div>
            </>
          )}


        </div>

        <div style={styles.pomodoroBox}>
          <div style={styles.pomodoroHeader}>
            <span>Reading Assistant</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11, color: '#8888aa', fontWeight: 'normal' }}>Translate</span>
              <button
                style={{
                  ...styles.toggle,
                  ...(settings.translation.enabled ? styles.toggleOn : {}),
                }}
                onClick={toggleTranslation}
                role="switch"
                aria-label="Translate website text"
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
          <div style={{ fontSize: 11, color: '#8a8ab0', marginTop: -6, marginBottom: 8, lineHeight: 1.4 }}>
            Read aloud and translate website text on the fly.
          </div>

          {settings.translation.enabled && (() => {
            const badges = {
              available: { text: '🔒 On-device AI ready', color: '#4ade80' },
              downloading: { text: '⏳ Downloading language model…', color: '#facc15' },
              unavailable: { text: '🌐 Using Google translation', color: '#8888aa' },
            };
            const badge = translatorStatus
              ? badges[translatorStatus]
              : { text: '🌐 Translation unavailable on this page', color: '#8a8ab0' };
            return (
              <div style={{ fontSize: 11, color: badge.color, marginTop: -4, marginBottom: 8, lineHeight: 1.4 }}>
                {badge.text}
              </div>
            );
          })()}

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

              <div
                ref={readAloudVolumeControlRef}
                style={{ position: 'relative', display: 'flex', alignItems: 'center' }}
                onWheel={(e) => {
                  if (!showReadAloudVolumeSlider) return;
                  e.preventDefault();
                  const step = 0.05;
                  const direction = e.deltaY < 0 ? 1 : -1;
                  const vol = settings.readAloud?.volume ?? 1;
                  let newVol = vol + (direction * step);
                  newVol = Math.max(0, Math.min(1, newVol));

                  const newSettings = { ...settings, updatedAt: Date.now(), readAloud: { ...settings.readAloud!, volume: newVol } };
                  setSettings(newSettings);
                  chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", payload: newSettings });
                }}
              >
                <button
                  onClick={() => setShowReadAloudVolumeSlider(!showReadAloudVolumeSlider)}
                  style={{ background: 'rgba(255,255,255,0.2)', border: 'none', borderRadius: 4, color: '#fff', cursor: 'pointer', padding: 4, display: 'flex', transition: 'background 0.2s' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.3)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,0.2)'}
                  title={`Volume: ${Math.round((settings.readAloud?.volume ?? 1) * 100)}%`}
                  aria-label={`Read aloud volume: ${Math.round((settings.readAloud?.volume ?? 1) * 100)}%`}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                    {(settings.readAloud?.volume ?? 1) === 0 ? (
                      <>
                        <line x1="23" y1="9" x2="17" y2="15"></line>
                        <line x1="17" y1="9" x2="23" y2="15"></line>
                      </>
                    ) : (
                      <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                    )}
                  </svg>
                </button>
                {showReadAloudVolumeSlider && (
                  <div style={{ position: 'absolute', bottom: '100%', marginBottom: 8, left: '50%', transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, zIndex: 10, background: '#1a1a2e', padding: '8px 4px', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.5)', border: '1px solid #3a3a5a' }}>
                    <span style={{ fontSize: 10, color: '#8888aa', fontWeight: 'bold', width: '28px', textAlign: 'center' }}>
                      {Math.round((settings.readAloud?.volume ?? 1) * 100)}%
                    </span>
                    <input
                      autoFocus
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={settings.readAloud?.volume ?? 1}
                      onChange={(e) => {
                        const vol = parseFloat(e.target.value);
                        const newSettings = { ...settings, updatedAt: Date.now(), readAloud: { ...settings.readAloud!, volume: vol } };
                        setSettings(newSettings);
                        chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", payload: newSettings });
                      }}
                      style={{ accentColor: '#4ade80', height: 60, width: 8, margin: 0, writingMode: 'vertical-lr', direction: 'rtl' }}
                    />
                  </div>
                )}
              </div>
            </div>
          )}
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
    if (state.status !== 'running' || settings.breathingEnabled === false || !state.breathStartTime) {
      setProgress({ currentPhaseIdx: 0, phaseProgress: 0, activePhases: [] });
      return;
    }

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

  const radius = 54;
  const strokeWidth = 6;
  const normalizedRadius = radius - strokeWidth / 2;
  const circumference = normalizedRadius * 2 * Math.PI;

  const showBreathing = settings.breathingEnabled !== false && state.status === 'running' && !!state.breathStartTime && progress.activePhases.length > 0;
  const totalCycleDuration = showBreathing ? progress.activePhases.reduce((acc, p) => acc + p.duration, 0) : 0;

  return (
    <svg width={112} height={112} style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%) rotate(-90deg)', pointerEvents: 'none' }}>
      <circle cx="56" cy="56" r={normalizedRadius} fill="transparent" stroke="#2a2a4a" strokeWidth={strokeWidth} />

      {showBreathing && progress.activePhases.map((phase, k) => {
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
    width: 32,
    height: 18,
    borderRadius: 9,
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
    top: 2,
    left: 2,
    width: 14,
    height: 14,
    borderRadius: "50%",
    background: "#fff",
    transition: "left 0.2s",
  },
  toggleThumbOn: { left: 16 },
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
  activeTaskRow: {
    display: 'flex',
    alignItems: 'baseline',
    gap: '8px',
    width: '100%',
    marginTop: '4px',
    background: '#2a2a4a',
    padding: '6px 12px',
    borderRadius: '6px',
    boxSizing: 'border-box',
  },
  activeTaskLabel: {
    fontSize: '9px',
    fontWeight: 'bold',
    color: '#8888aa',
    letterSpacing: '0.5px',
    flexShrink: 0,
  },
  activeTaskName: {
    fontSize: '13px',
    color: '#4ade80',
    fontWeight: 600,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    wordBreak: 'break-word',
    flex: 1,
  },
  pomodoroTime: {
    fontSize: 26,
    fontWeight: "bold",
    color: "#fff",
    fontFamily: "monospace",
    letterSpacing: 1
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
