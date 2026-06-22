import { Message, PomodoroState, PomodoroSettings, DEFAULT_SETTINGS } from '../shared/types';
import { recognizeText } from './ocr';

let state: PomodoroState = {
  phase: 'idle',
  status: 'stopped',
  timeRemaining: 25 * 60,
  completedFocusSessions: 0
};

let settings: PomodoroSettings = DEFAULT_SETTINGS.pomodoro!;

let timerInterval: number | null = null;
let animationInterval: number | null = null;
let breathStartTime = 0;
let lastCycleTime = 0;

// Audio context for chime
const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();

function playChime() {
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }

  // A bright, exciting "success" arpeggio (C major: C5, E5, G5, C6)
  const notes = [523.25, 659.25, 783.99, 1046.50];
  const now = audioCtx.currentTime;

  notes.forEach((freq, index) => {
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    osc.type = 'triangle'; // Bell-like bright tone
    osc.frequency.setValueAtTime(freq, now + index * 0.15);

    const vol = Math.min(settings.volume ?? 1, 1.5); // Cap chime volume to prevent clipping
    gainNode.gain.setValueAtTime(0, now + index * 0.15);
    gainNode.gain.linearRampToValueAtTime(0.2 * vol, now + index * 0.15 + 0.05); // quick attack
    gainNode.gain.setTargetAtTime(0, now + index * 0.15 + 0.05, 0.38); // natural exponential tail to silence

    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    osc.start(now + index * 0.15);
    osc.stop(now + index * 0.15 + 2.0);
  });
}

function playBattleChime() {
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }

  const now = audioCtx.currentTime;
  const vol = Math.min(settings.volume ?? 1, 1.5); // Cap chime volume to prevent clipping
  const bpm = 140; // fast
  const beat = 60 / bpm; // duration of one beat in seconds

  const notes = [
    { f: 392.00, start: 0, dur: 0.5 * beat },      // G4
    { f: 523.25, start: 0.5 * beat, dur: 0.5 * beat }, // C5
    { f: 659.25, start: 1.0 * beat, dur: 0.5 * beat }, // E5
    { f: 783.99, start: 1.5 * beat, dur: 1.5 * beat }, // G5
    // Rest for 0.5 beat
    { f: 659.25, start: 3.5 * beat, dur: 0.5 * beat }, // E5
    { f: 783.99, start: 4.0 * beat, dur: 2.4 * beat }, // G5
  ];

  notes.forEach(({ f, start, dur }) => {
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    // Sawtooth wave gives it a brassy, bugle-like sound
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(f, now + start);

    // A bit of lowpass filter to make the sawtooth less harsh
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(2000, now + start);

    gainNode.gain.setValueAtTime(0, now + start);
    gainNode.gain.linearRampToValueAtTime(0.15 * vol, now + start + 0.05); // attack
    gainNode.gain.setValueAtTime(0.15 * vol, now + start + dur - 0.1); // sustain
    gainNode.gain.linearRampToValueAtTime(0, now + start + dur); // release

    osc.connect(filter);
    filter.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    osc.start(now + start);
    osc.stop(now + start + dur);
  });
}

let noiseNode: AudioBufferSourceNode | null = null;
let breathGain: GainNode | null = null;
let breathFilter: BiquadFilterNode | null = null;

function initBreathingSound() {
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  if (settings.breathingEnabled === false) return;
  if (noiseNode) return;

  const bufferSize = audioCtx.sampleRate * 2;
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);

  let lastOut = 0;
  for (let i = 0; i < bufferSize; i++) {
    const white = Math.random() * 2 - 1;
    data[i] = (lastOut + (0.02 * white)) / 1.02; // Brown noise approximation
    lastOut = data[i];
    data[i] *= 3.5; // Base gain
  }

  noiseNode = audioCtx.createBufferSource();
  noiseNode.buffer = buffer;
  noiseNode.loop = true;

  breathFilter = audioCtx.createBiquadFilter();
  breathFilter.type = 'lowpass';
  breathFilter.frequency.value = 400; // Will be modulated

  breathGain = audioCtx.createGain();
  breathGain.gain.value = 0;

  noiseNode.connect(breathFilter);
  breathFilter.connect(breathGain);
  breathGain.connect(audioCtx.destination);

  noiseNode.start();
}

function stopBreathingSound() {
  if (breathGain) {
    breathGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.1);
  }
}

const canvas = document.getElementById('icon-canvas') as HTMLCanvasElement;
canvas.width = 128;
canvas.height = 128;
const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

function updateBadge() {
  // Clear the native badge so it doesn't obscure the canvas
  chrome.runtime.sendMessage({ type: 'UPDATE_ACTION_BADGE', payload: { text: '' } });
}

function animateIcon() {
  if (state.status !== 'running') return;

  const elapsed = (Date.now() - breathStartTime) / 1000;

  const i = settings.inhale ?? 8;
  const h1 = settings.hold1 ?? 4;
  const e = settings.exhale ?? 8;
  const h2 = settings.hold2 ?? 4;
  const totalCycle = i + h1 + e + h2;

  let cycleTime = 0;
  if (totalCycle > 0) {
    cycleTime = elapsed % totalCycle;
  }

  // Check if we should finish the session at the end of the breathing cycle
  if (state.timeRemaining === 0 && settings.breathingEnabled !== false && totalCycle > 0) {
    // If cycleTime wrapped around (current is smaller than last)
    if (lastCycleTime > 0 && cycleTime < lastCycleTime) {
      finishPomodoroSession();
      return;
    }
  }
  lastCycleTime = cycleTime;

  ctx.clearRect(0, 0, 128, 128);

  const CENTER = 64;
  const RADIUS = 54;
  const LINE_WIDTH = 20;

  // Base background so text is readable
  ctx.beginPath();
  ctx.arc(CENTER, CENTER, RADIUS, 0, 2 * Math.PI);
  ctx.fillStyle = '#111122';
  ctx.fill();

  if (settings.breathingEnabled !== false) {
    ctx.beginPath();
    ctx.arc(CENTER, CENTER, RADIUS, 0, 2 * Math.PI);
    ctx.strokeStyle = '#333';
    ctx.lineWidth = LINE_WIDTH;
    ctx.stroke();

    const activePhases: { type: string, duration: number, color: string }[] = [];
    if (i > 0) activePhases.push({ type: 'inhale', duration: i, color: '#4ade80' }); // Green
    if (h1 > 0) activePhases.push({ type: 'hold1', duration: h1, color: '#facc15' }); // Yellow
    if (e > 0) activePhases.push({ type: 'exhale', duration: e, color: '#60a5fa' }); // Blue
    if (h2 > 0) activePhases.push({ type: 'hold2', duration: h2, color: '#c084fc' }); // Purple

    const numSegments = activePhases.length;

    if (numSegments > 0) {
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

      const totalCycleDuration = activePhases.reduce((acc, p) => acc + p.duration, 0);
      const baseAngle = -Math.PI / 2;

      ctx.lineWidth = LINE_WIDTH;

      // Draw fully completed segments
      let startAccumulated = 0;
      for (let k = 0; k < currentPhaseIdx; k++) {
        const phaseAngle = (activePhases[k].duration / totalCycleDuration) * 2 * Math.PI;
        const startAngle = baseAngle + (startAccumulated / totalCycleDuration) * 2 * Math.PI;
        ctx.beginPath();
        ctx.arc(CENTER, CENTER, RADIUS, startAngle, startAngle + phaseAngle);
        ctx.strokeStyle = activePhases[k].color;
        ctx.stroke();
        startAccumulated += activePhases[k].duration;
      }

      // Draw the currently active segment (partial)
      const currentPhaseStartAngle = baseAngle + (startAccumulated / totalCycleDuration) * 2 * Math.PI;
      const currentPhaseAngle = (activePhases[currentPhaseIdx].duration / totalCycleDuration) * phaseProgress * 2 * Math.PI;

      ctx.beginPath();
      ctx.arc(CENTER, CENTER, RADIUS, currentPhaseStartAngle, currentPhaseStartAngle + currentPhaseAngle);
      ctx.strokeStyle = activePhases[currentPhaseIdx].color;
      ctx.stroke();

      // Modulate breathing audio continuously
      if (breathGain && breathFilter) {
        let targetVolume = 0;
        let targetFreq = 400;

        const currentPhaseType = activePhases[currentPhaseIdx]?.type;

        if (currentPhaseType === 'inhale') {
          // Wind rushing in
          targetVolume = 0.02 + (0.4 - 0.02) * phaseProgress;
          targetFreq = 300 + (1000 - 300) * phaseProgress;
        } else if (currentPhaseType === 'hold1') {
          // Stop breathing: quick smooth decay to a quiet hum
          targetVolume = 0.15;
          targetFreq = 350;
        } else if (currentPhaseType === 'exhale') {
          // Gentle push of air out, then slow fade
          if (phaseProgress < 0.1) {
            const p = phaseProgress / 0.1;
            targetVolume = 0.05 + (0.35 - 0.05) * p;
            targetFreq = 300 + (900 - 300) * p;
          } else {
            const p = (phaseProgress - 0.1) / 0.9;
            targetVolume = 0.35 + (0.02 - 0.35) * p;
            targetFreq = 900 + (300 - 900) * p;
          }
        } else if (currentPhaseType === 'hold2') {
          // Lungs empty: near silence
          targetVolume = 0.02;
          targetFreq = 300;
        }

        // Use a larger time constant (0.1s) to organically smooth out the corners between phases!
        const vol = settings.volume ?? 1;
        breathGain.gain.setTargetAtTime(targetVolume * vol, audioCtx.currentTime, 0.1);
        breathFilter.frequency.setTargetAtTime(targetFreq, audioCtx.currentTime, 0.1);
      }
    } else {
      // If no active phases, ensure audio is quiet
      if (breathGain) breathGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.1);
    }
  }

  // Draw Pomodoro countdown in the center
  const mins = Math.ceil(state.timeRemaining / 60);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 70px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(mins.toString(), CENTER, CENTER + 6); // optical center adjust

  const imageData = ctx.getImageData(0, 0, 128, 128);
  chrome.runtime.sendMessage({
    type: 'UPDATE_ACTION_ICON',
    payload: {
      data: Array.from(imageData.data),
      width: 128,
      height: 128
    }
  });
}

function restoreDefaultIcon() {
  chrome.runtime.sendMessage({ type: 'RESTORE_ACTION_ICON' });
}

function finishPomodoroSession() {
  const currentPhase = state.phase;
  if (currentPhase === 'shortBreak' || currentPhase === 'longBreak') {
    playBattleChime();
  } else {
    playChime();
  }

  state.status = 'stopped';

  let nextPhase = state.phase;
  let nextTime = 0;

  if (state.phase === 'focus') {
    state.completedFocusSessions++;
    if (state.completedFocusSessions % settings.longBreakInterval === 0) {
      nextPhase = 'longBreak';
      nextTime = settings.longBreakTime * 60;
    } else {
      nextPhase = 'shortBreak';
      nextTime = settings.shortBreakTime * 60;
    }
  } else {
    nextPhase = 'focus';
    nextTime = settings.focusTime * 60;
  }

  state.phase = nextPhase as any;
  state.timeRemaining = nextTime;

  stopTimer();
  updateBadge();
  broadcastState();

  const autoStart = (nextPhase === 'focus' && settings.autoStartPomodoro) ||
    ((nextPhase === 'shortBreak' || nextPhase === 'longBreak') && settings.autoStartBreak);

  if (autoStart) {
    // Wait for the chime to finish before auto-starting
    const delayMs = currentPhase === 'shortBreak' || currentPhase === 'longBreak' ? 3600 : 2800;
    setTimeout(() => {
      if (state.status === 'stopped' && state.phase === nextPhase) {
        state.status = 'running';
        startTimer();
        updateBadge();
        broadcastState();
      }
    }, delayMs);
  }
}

function tick() {
  if (state.status !== 'running') return;

  if (state.timeRemaining > 0) {
    state.timeRemaining--;
    updateBadge();
    broadcastState();
  }

  // If time is 0 and breathing is disabled (or cycle is 0), finish immediately
  if (state.timeRemaining === 0) {
    const i = settings.inhale ?? 8;
    const h1 = settings.hold1 ?? 4;
    const e = settings.exhale ?? 8;
    const h2 = settings.hold2 ?? 4;
    const totalCycle = i + h1 + e + h2;

    if (settings.breathingEnabled === false || totalCycle === 0) {
      finishPomodoroSession();
    }
  }
}

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = window.setInterval(tick, 1000);

  if (animationInterval) clearInterval(animationInterval);
  breathStartTime = Date.now();
  state.breathStartTime = breathStartTime;
  lastCycleTime = 0;
  animationInterval = window.setInterval(animateIcon, 50);

  initBreathingSound();
}

function stopTimer() {
  if (timerInterval) clearInterval(timerInterval);
  if (animationInterval) clearInterval(animationInterval);
  timerInterval = null;
  animationInterval = null;
  stopBreathingSound();
  restoreDefaultIcon();
}

function broadcastState() {
  chrome.runtime.sendMessage({ type: 'POMODORO_STATE_UPDATE', payload: state });
}

chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
  if (msg.type === 'GET_POMODORO_STATE') {
    sendResponse(state);
    return true; // We send response asynchronously (or synchronously here, true is safe)
  }

  if (msg.type === 'POMODORO_COMMAND') {
    const cmd = msg.payload as { action: string, settings?: PomodoroSettings };
    if (cmd.settings) {
      settings = cmd.settings;
    }

    switch (cmd.action) {
      case 'updateSettings':
        if (settings.breathingEnabled === false) {
          stopBreathingSound();
        } else if (state.status === 'running') {
          initBreathingSound();
        }
        break;
      case 'startFocus':
        state.phase = 'focus';
        state.timeRemaining = settings.focusTime * 60;
        state.status = 'running';
        startTimer();
        updateBadge();
        break;
      case 'startShortBreak':
        state.phase = 'shortBreak';
        state.timeRemaining = settings.shortBreakTime * 60;
        state.status = 'running';
        startTimer();
        updateBadge();
        break;
      case 'startLongBreak':
        state.phase = 'longBreak';
        state.timeRemaining = settings.longBreakTime * 60;
        state.status = 'running';
        startTimer();
        updateBadge();
        break;
      case 'pause':
        state.status = 'paused';
        stopTimer();
        break;
      case 'resume':
        if (state.phase !== 'idle' && state.timeRemaining > 0) {
          state.status = 'running';
          startTimer();
        }
        break;
      case 'stop':
        state.status = 'stopped';
        state.phase = 'idle';
        stopTimer();
        chrome.runtime.sendMessage({ type: 'UPDATE_ACTION_BADGE', payload: { text: '' } });
        break;
    }
    broadcastState();
    sendResponse(state);
    return true;
  }

  if (msg.type === 'RECOGNIZE_TEXT') {
    const { imageBase64, lang, tabId } = msg.payload as { imageBase64: string; lang: string; tabId?: number };
    // Don't use sendResponse for OCR — takes too long and kills the channel
    // Instead send OCR_COMPLETE via runtime message so background can forward to tab
    recognizeText(imageBase64, lang, (status, progress) => {
      chrome.runtime.sendMessage({
        type: 'OCR_PROGRESS',
        payload: { status, progress, tabId }
      }).catch(() => { });
    }).then(text => {
      chrome.runtime.sendMessage({
        type: 'OCR_COMPLETE',
        payload: { text, tabId }
      }).catch(() => { });
    }).catch(err => {
      console.error('OCR Error:', err);
      chrome.runtime.sendMessage({
        type: 'OCR_COMPLETE',
        payload: { error: err ? (err.message || err.toString()) : 'Unknown error', tabId }
      }).catch(() => { });
    });
    sendResponse({ ack: true }); // Respond immediately
    return true;
  }
});
