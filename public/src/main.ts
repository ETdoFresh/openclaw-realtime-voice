import './style.css';

// ─── Types ────────────────────────────────────────────────────────────

interface ServerMessage {
  type: string;
  userId?: string;
  fromUserId?: string;
  targetUserId?: string;
  users?: string[];
  audio?: string;
  text?: string;
  taskId?: string;
  message?: string;
  error?: boolean | string;
  active?: boolean;
  globalActive?: boolean;
  connected?: boolean;
  muted?: boolean;
  role?: string;
  partial?: boolean;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

// ─── State ────────────────────────────────────────────────────────────

let ws: WebSocket | null = null;
let myUserId: string = '';
let localStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let aiAudioContext: AudioContext | null = null;

// Peer connections for mesh WebRTC
const peerConnections = new Map<string, RTCPeerConnection>();

// Audio capture for AI
let audioWorkletNode: ScriptProcessorNode | null = null;
let audioSourceNode: MediaStreamAudioSourceNode | null = null;

// UI state
let isConnected = false;
let isMuted = false;
let isAiActive = false;
let isPttActive = false;
let aiConnected = false;

// Auth
let authToken = sessionStorage.getItem('voiceAuthToken') || '';

// Transcript
interface TranscriptEntry { role: 'user' | 'assistant' | 'system'; text: string; timestamp: number; }
const transcript: TranscriptEntry[] = [];

// Tasks
interface Task { id: string; message: string; status: 'pending' | 'completed' | 'error'; timestamp: number; }
const activeTasks = new Map<string, Task>();

// Audio visualizer
let analyser: AnalyserNode | null = null;
let micSource: MediaStreamAudioSourceNode | null = null;
let animationFrameId: number | null = null;

// Partial transcript accumulator
let partialAssistantText = '';

// ─── DOM Elements ─────────────────────────────────────────────────────

const authOverlay = document.getElementById('authOverlay') as HTMLDivElement;
const authInput = document.getElementById('authInput') as HTMLInputElement;
const authSubmitBtn = document.getElementById('authSubmitBtn') as HTMLButtonElement;
const authError = document.getElementById('authError') as HTMLDivElement;

const statusIndicator = document.getElementById('statusIndicator') as HTMLDivElement;
const statusText = document.getElementById('statusText') as HTMLDivElement;
const logDiv = document.getElementById('log') as HTMLDivElement;
const connectBtn = document.getElementById('connectBtn') as HTMLButtonElement;
const muteBtn = document.getElementById('muteBtn') as HTMLButtonElement;
const aiActiveBtn = document.getElementById('aiActiveBtn') as HTMLButtonElement;
const pttBtn = document.getElementById('pttBtn') as HTMLButtonElement;
const voiceSelect = document.getElementById('voiceSelect') as HTMLSelectElement;
const visualizerCanvas = document.getElementById('visualizer') as HTMLCanvasElement;
const taskStatusDiv = document.getElementById('taskStatus') as HTMLDivElement;
const transcriptSidebar = document.getElementById('transcriptSidebar') as HTMLDivElement;
const transcriptContent = document.getElementById('transcriptContent') as HTMLDivElement;
const transcriptToggle = document.getElementById('transcriptToggle') as HTMLButtonElement;
const newSessionBtn = document.getElementById('newSessionBtn') as HTMLButtonElement;
const showTranscriptBtn = document.getElementById('showTranscriptBtn') as HTMLButtonElement;
const userCountSpan = document.getElementById('userCount') as HTMLSpanElement;

// ─── Auth ─────────────────────────────────────────────────────────────

async function checkAuth(): Promise<void> {
  try {
    const res = await fetch('/api/auth/status');
    const { authRequired } = await res.json();
    if (!authRequired) { authOverlay.style.display = 'none'; return; }
    if (authToken) {
      const verifyRes = await fetch('/api/auth/verify', { method: 'POST', headers: { 'Authorization': `Bearer ${authToken}` } });
      if (verifyRes.ok) { authOverlay.style.display = 'none'; return; }
      sessionStorage.removeItem('voiceAuthToken');
      authToken = '';
    }
    authOverlay.style.display = 'flex';
  } catch { authOverlay.style.display = 'none'; }
}

async function submitAuth(): Promise<void> {
  const token = authInput.value.trim();
  if (!token) return;
  authSubmitBtn.disabled = true;
  authError.style.display = 'none';
  try {
    const res = await fetch('/api/auth/verify', { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } });
    if (res.ok) { authToken = token; sessionStorage.setItem('voiceAuthToken', token); authOverlay.style.display = 'none'; }
    else { authError.style.display = 'block'; }
  } catch { authError.textContent = 'Connection error'; authError.style.display = 'block'; }
  authSubmitBtn.disabled = false;
}

authSubmitBtn.addEventListener('click', submitAuth);
authInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAuth(); });

// ─── Logging ──────────────────────────────────────────────────────────

function log(message: string, type: 'info' | 'success' | 'error' | 'task' = 'info'): void {
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logDiv.appendChild(entry);
  logDiv.scrollTop = logDiv.scrollHeight;
}

function setStatus(status: '' | 'connected' | 'connecting', text: string): void {
  statusIndicator.className = `status-indicator ${status}`;
  statusText.className = `status-text ${status}`;
  statusText.textContent = text;
}

// ─── Transcript ───────────────────────────────────────────────────────

function addToTranscript(role: 'user' | 'assistant' | 'system', text: string): void {
  transcript.push({ role, text, timestamp: Date.now() });
  renderTranscript();
}

function renderTranscript(): void {
  transcriptContent.innerHTML = '';
  transcript.forEach(entry => {
    const div = document.createElement('div');
    div.className = `transcript-entry ${entry.role}`;
    div.innerHTML = `<div class="transcript-role">${entry.role}</div><div class="transcript-text">${entry.text}</div><div class="transcript-time">${new Date(entry.timestamp).toLocaleTimeString()}</div>`;
    transcriptContent.appendChild(div);
  });
  transcriptContent.scrollTop = transcriptContent.scrollHeight;
}

// ─── Tasks ────────────────────────────────────────────────────────────

function addTask(taskId: string, message: string): void {
  activeTasks.set(taskId, { id: taskId, message, status: 'pending', timestamp: Date.now() });
  renderTaskStatus();
}

function updateTaskStatus(taskId: string, status: 'completed' | 'error'): void {
  const task = activeTasks.get(taskId);
  if (task) { task.status = status; renderTaskStatus(); setTimeout(() => { activeTasks.delete(taskId); renderTaskStatus(); }, 5000); }
}

function renderTaskStatus(): void {
  if (activeTasks.size === 0) { taskStatusDiv.innerHTML = '<div style="color: #666; text-align: center; padding: 20px;">No active tasks</div>'; return; }
  taskStatusDiv.innerHTML = '';
  activeTasks.forEach(task => {
    const div = document.createElement('div');
    div.className = `task-item ${task.status}`;
    const icon = task.status === 'pending' ? '<div class="task-spinner"></div>'
      : task.status === 'completed' ? '<div class="task-checkmark"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div>'
      : '<div class="task-error-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>';
    div.innerHTML = `${icon}<div class="task-text">${task.message}</div>`;
    taskStatusDiv.appendChild(div);
  });
}

// ─── Audio Visualizer ─────────────────────────────────────────────────

function setupVisualizer(stream: MediaStream): void {
  audioContext = new AudioContext();
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  micSource = audioContext.createMediaStreamSource(stream);
  micSource.connect(analyser);
  startVisualization();
}

function startVisualization(): void {
  if (!analyser || !visualizerCanvas) return;
  const ctx = visualizerCanvas.getContext('2d');
  if (!ctx) return;
  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  const draw = () => {
    animationFrameId = requestAnimationFrame(draw);
    analyser!.getByteFrequencyData(dataArray);
    const width = visualizerCanvas.width;
    const height = visualizerCanvas.height;
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, width, height);
    const barWidth = (width / bufferLength) * 2.5;
    let x = 0;
    for (let i = 0; i < bufferLength; i++) {
      const barHeight = (dataArray[i] / 255) * height * 0.8;
      const gradient = ctx.createLinearGradient(0, height - barHeight, 0, height);
      gradient.addColorStop(0, '#667eea');
      gradient.addColorStop(1, '#764ba2');
      ctx.fillStyle = gradient;
      ctx.fillRect(x, height - barHeight, barWidth, barHeight);
      x += barWidth + 1;
    }
  };
  draw();
}

function stopVisualization(): void {
  if (animationFrameId) { cancelAnimationFrame(animationFrameId); animationFrameId = null; }
  if (micSource) { micSource.disconnect(); micSource = null; }
  if (audioContext) { audioContext.close(); audioContext = null; }
  const ctx = visualizerCanvas?.getContext('2d');
  if (ctx) { ctx.fillStyle = '#111'; ctx.fillRect(0, 0, visualizerCanvas.width, visualizerCanvas.height); }
}

// ─── AI Audio Playback ────────────────────────────────────────────────

// Queue-based audio playback for smooth AI voice
let aiNextPlayTime = 0;

function ensureAiAudioContext(): AudioContext {
  if (!aiAudioContext || aiAudioContext.state === 'closed') {
    aiAudioContext = new AudioContext({ sampleRate: 24000 });
  }
  return aiAudioContext;
}

function playAiAudio(base64Audio: string): void {
  const ctx = ensureAiAudioContext();

  // Decode base64 to PCM16
  const binaryString = atob(base64Audio);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);

  const pcm16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 32768;

  const buffer = ctx.createBuffer(1, float32.length, 24000);
  buffer.getChannelData(0).set(float32);

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);

  const now = ctx.currentTime;
  const startTime = Math.max(now, aiNextPlayTime);
  source.start(startTime);
  aiNextPlayTime = startTime + buffer.duration;
}

function resetAiAudioQueue(): void {
  aiNextPlayTime = 0;
}

// ─── Audio capture for AI ─────────────────────────────────────────────

function setupAudioCapture(stream: MediaStream): void {
  // Use a separate AudioContext for capture at 24kHz (OpenAI's expected rate)
  // ScriptProcessorNode for compatibility; captures raw PCM
  const captureCtx = new AudioContext({ sampleRate: 24000 });
  audioSourceNode = captureCtx.createMediaStreamSource(stream);

  // ScriptProcessor: 4096 samples buffer, mono in, mono out
  audioWorkletNode = captureCtx.createScriptProcessor(4096, 1, 1);

  audioWorkletNode.onaudioprocess = (e) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (isMuted) return;
    // Only send if AI active or PTT active
    if (!isAiActive && !isPttActive) return;

    const inputData = e.inputBuffer.getChannelData(0);
    // Convert float32 to PCM16
    const pcm16 = new Int16Array(inputData.length);
    for (let i = 0; i < inputData.length; i++) {
      const s = Math.max(-1, Math.min(1, inputData[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }

    // Convert to base64
    const bytes = new Uint8Array(pcm16.buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const base64 = btoa(binary);

    ws.send(JSON.stringify({ type: 'audio-data', audio: base64 }));
  };

  audioSourceNode.connect(audioWorkletNode);
  audioWorkletNode.connect(captureCtx.destination); // Required for ScriptProcessor to work
}

// ─── WebRTC Mesh ──────────────────────────────────────────────────────

function createPeerConnection(remoteUserId: string, isInitiator: boolean): RTCPeerConnection {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });

  // Add local tracks
  if (localStream) {
    localStream.getTracks().forEach(track => {
      pc.addTrack(track, localStream!);
    });
  }

  // Handle incoming tracks
  pc.ontrack = (event) => {
    log(`Audio from ${remoteUserId.slice(-6)}`, 'success');
    const audio = new Audio();
    audio.srcObject = event.streams[0];
    audio.autoplay = true;
  };

  // ICE candidates
  pc.onicecandidate = (event) => {
    if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ice-candidate', targetUserId: remoteUserId, candidate: event.candidate.toJSON() }));
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      peerConnections.delete(remoteUserId);
      pc.close();
    }
  };

  peerConnections.set(remoteUserId, pc);

  if (isInitiator) {
    pc.createOffer().then(offer => pc.setLocalDescription(offer)).then(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'offer', targetUserId: remoteUserId, sdp: pc.localDescription }));
      }
    });
  }

  return pc;
}

// ─── WebSocket message handling ───────────────────────────────────────

function handleServerMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case 'welcome':
      myUserId = msg.userId || '';
      log(`Joined as ${myUserId.slice(-6)}`, 'success');
      // Send join
      ws!.send(JSON.stringify({
        type: 'join',
        voice: voiceSelect.value,
      }));
      break;

    case 'room-users':
      // Create peer connections to existing users (we are initiator)
      if (msg.users) {
        updateUserCount(msg.users.length + 1);
        msg.users.forEach(userId => createPeerConnection(userId, true));
      }
      break;

    case 'user-joined':
      if (msg.userId) {
        log(`User ${msg.userId.slice(-6)} joined`, 'info');
        createPeerConnection(msg.userId, false); // they will send offer
        updateUserCount(peerConnections.size + 1);
      }
      break;

    case 'user-left':
      if (msg.userId) {
        log(`User ${msg.userId.slice(-6)} left`, 'info');
        const pc = peerConnections.get(msg.userId);
        if (pc) { pc.close(); peerConnections.delete(msg.userId); }
        updateUserCount(peerConnections.size + 1);
      }
      break;

    case 'offer': {
      const pc = peerConnections.get(msg.fromUserId!) || createPeerConnection(msg.fromUserId!, false);
      pc.setRemoteDescription(new RTCSessionDescription(msg.sdp!)).then(() => pc.createAnswer())
        .then(answer => pc.setLocalDescription(answer))
        .then(() => {
          ws!.send(JSON.stringify({ type: 'answer', targetUserId: msg.fromUserId, sdp: pc.localDescription }));
        });
      break;
    }

    case 'answer': {
      const pc = peerConnections.get(msg.fromUserId!);
      if (pc) pc.setRemoteDescription(new RTCSessionDescription(msg.sdp!));
      break;
    }

    case 'ice-candidate': {
      const pc = peerConnections.get(msg.fromUserId!);
      if (pc && msg.candidate) pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
      break;
    }

    case 'ai-audio':
      if (msg.audio) playAiAudio(msg.audio);
      break;

    case 'ai-audio-done':
      // Audio stream complete for this response
      break;

    case 'ai-status':
      aiConnected = !!msg.connected;
      log(`AI ${aiConnected ? 'connected' : 'disconnected'}`, aiConnected ? 'success' : 'info');
      break;

    case 'ai-active-changed':
      log(`AI ${msg.globalActive ? 'active' : 'inactive'} (${msg.userId?.slice(-6)} ${msg.active ? 'on' : 'off'})`, 'info');
      break;

    case 'transcript':
      if (msg.role === 'assistant') {
        if (msg.partial) {
          partialAssistantText = (partialAssistantText || '') + msg.text;
        } else {
          partialAssistantText = '';
          addToTranscript('assistant', msg.text || '');
        }
      } else if (msg.role === 'user') {
        addToTranscript('user', msg.text || '');
      }
      break;

    case 'speech-started':
      // VAD detected speech in audio sent to OpenAI
      break;

    case 'speech-stopped':
      break;

    case 'task-created':
      if (msg.taskId && msg.message) {
        addTask(msg.taskId, msg.message);
        addToTranscript('system', `Task queued: ${msg.message}`);
        log(`Task queued: ${msg.message}`, 'task');
      }
      break;

    case 'result':
      if (msg.taskId) updateTaskStatus(msg.taskId, msg.error ? 'error' : 'completed');
      addToTranscript('system', `Result: ${msg.text || ''}`);
      log(`Result: ${msg.text}`, msg.error ? 'error' : 'task');
      break;

    case 'notification':
      addToTranscript('system', `Notification: ${msg.text || ''}`);
      log(`Notification: ${msg.text}`, 'info');
      break;

    case 'response-done':
      resetAiAudioQueue();
      break;

    case 'ai-error':
      log(`AI error: ${msg.error}`, 'error');
      break;

    case 'user-muted':
      log(`User ${msg.userId?.slice(-6)} ${msg.muted ? 'muted' : 'unmuted'}`, 'info');
      break;
  }
}

// ─── Connect / Disconnect ─────────────────────────────────────────────

async function connect(): Promise<void> {
  try {
    setStatus('connecting', 'Connecting...');
    connectBtn.disabled = true;
    log('Getting microphone access...', 'info');

    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    log('Microphone access granted', 'success');

    // Start muted
    localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);

    setupVisualizer(localStream);
    setupAudioCapture(localStream);

    // Connect WebSocket
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const tokenParam = authToken ? `?token=${encodeURIComponent(authToken)}` : '';
    ws = new WebSocket(`${protocol}//${window.location.host}/ws${tokenParam}`);

    ws.onopen = () => {
      log('Connected to server', 'success');
      isConnected = true;
      setStatus('connected', isMuted ? 'Connected - Muted' : 'Connected');
      updateButtonStates();
    };

    ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data) as ServerMessage;
        handleServerMessage(msg);
      } catch { /* ignore */ }
    };

    ws.onerror = () => log('WebSocket error', 'error');

    ws.onclose = () => {
      log('Disconnected from server', 'info');
      isConnected = false;
      setStatus('', 'Disconnected');
      cleanup();
      updateButtonStates();
    };

  } catch (error) {
    log(`Connection error: ${(error as Error).message}`, 'error');
    setStatus('', 'Disconnected');
    cleanup();
    updateButtonStates();
  }
}

function disconnect(): void {
  log('Disconnecting...', 'info');
  isAiActive = false;
  isPttActive = false;
  cleanup();
  setStatus('', 'Disconnected');
  isConnected = false;
  updateButtonStates();
}

function cleanup(): void {
  stopVisualization();

  for (const [, pc] of peerConnections) pc.close();
  peerConnections.clear();

  if (ws) { ws.close(); ws = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (audioWorkletNode) { audioWorkletNode.disconnect(); audioWorkletNode = null; }
  if (audioSourceNode) { audioSourceNode.disconnect(); audioSourceNode = null; }
  if (aiAudioContext) { aiAudioContext.close(); aiAudioContext = null; }

  resetAiAudioQueue();
}

// ─── Button handlers ──────────────────────────────────────────────────

function updateButtonStates(): void {
  connectBtn.textContent = isConnected ? 'Disconnect' : 'Connect';
  connectBtn.className = isConnected ? 'btn-disconnect' : 'btn-connect';
  connectBtn.disabled = false;

  muteBtn.disabled = !isConnected;
  aiActiveBtn.disabled = !isConnected;
  pttBtn.disabled = !isConnected;
  newSessionBtn.disabled = !isConnected;

  updateMuteButton();
  updateAiActiveButton();
}

function updateMuteButton(): void {
  muteBtn.classList.toggle('muted', isMuted);
  muteBtn.innerHTML = isMuted
    ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28z"/><path d="M14.98 11.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99z"/><path d="M4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/></svg><span>Unmute</span>`
    : `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg><span>Mute</span>`;
}

function updateAiActiveButton(): void {
  aiActiveBtn.classList.toggle('active', isAiActive);
  aiActiveBtn.innerHTML = isAiActive
    ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg><span>AI Active</span>`
    : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/></svg><span>AI Off</span>`;
}

function toggleConnect(): void {
  if (isConnected) disconnect();
  else connect();
}

function toggleMute(): void {
  isMuted = !isMuted;
  if (localStream) {
    localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'mute', muted: isMuted }));
  }
  updateMuteButton();
  log(isMuted ? 'Microphone muted' : 'Microphone unmuted', 'info');
  if (isConnected) {
    setStatus('connected', isMuted ? 'Connected - Muted' : 'Connected');
  }
}

function toggleAiActive(): void {
  isAiActive = !isAiActive;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ai-active', active: isAiActive }));
  }
  updateAiActiveButton();
  log(isAiActive ? 'AI activated — all audio streams to AI' : 'AI deactivated', isAiActive ? 'success' : 'info');
}

function pttStart(): void {
  if (!isConnected) return;
  isPttActive = true;
  pttBtn.classList.add('active');
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ptt-start' }));
  }
  log('Push-to-talk: ON', 'info');
}

function pttEnd(): void {
  if (!isPttActive) return;
  isPttActive = false;
  pttBtn.classList.remove('active');
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ptt-stop' }));
  }
  log('Push-to-talk: OFF', 'info');
}

function updateUserCount(count: number): void {
  if (userCountSpan) userCountSpan.textContent = `${count}`;
}

// ─── Settings ─────────────────────────────────────────────────────────

voiceSelect.addEventListener('change', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'update-settings', voice: voiceSelect.value }));
  }
});

// ─── Transcript sidebar ───────────────────────────────────────────────

function updateShowTranscriptBtn(): void {
  showTranscriptBtn.classList.toggle('visible', transcriptSidebar.classList.contains('hidden'));
}

transcriptToggle.addEventListener('click', () => { transcriptSidebar.classList.add('hidden'); updateShowTranscriptBtn(); });
showTranscriptBtn.addEventListener('click', () => { transcriptSidebar.classList.remove('hidden'); updateShowTranscriptBtn(); });
updateShowTranscriptBtn();

// ─── New session ──────────────────────────────────────────────────────

async function newSession(): Promise<void> {
  log('Resetting session...', 'info');
  newSessionBtn.disabled = true;
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    const res = await fetch('/api/session/reset', { method: 'POST', headers });
    if (res.ok) log('Session cleared', 'success');
    else log('Session reset failed', 'error');
  } catch (e) { log(`Reset error: ${(e as Error).message}`, 'error'); }
  activeTasks.clear();
  renderTaskStatus();
  transcript.length = 0;
  renderTranscript();
  newSessionBtn.disabled = false;
}

// ─── Event listeners ──────────────────────────────────────────────────

connectBtn.addEventListener('click', toggleConnect);
muteBtn.addEventListener('click', toggleMute);
aiActiveBtn.addEventListener('click', toggleAiActive);
newSessionBtn.addEventListener('click', newSession);

// PTT: hold to talk
pttBtn.addEventListener('mousedown', pttStart);
pttBtn.addEventListener('mouseup', pttEnd);
pttBtn.addEventListener('mouseleave', pttEnd);
pttBtn.addEventListener('touchstart', (e) => { e.preventDefault(); pttStart(); });
pttBtn.addEventListener('touchend', (e) => { e.preventDefault(); pttEnd(); });
pttBtn.addEventListener('touchcancel', pttEnd);

// ─── Init ─────────────────────────────────────────────────────────────

log('Ready to connect', 'info');
renderTaskStatus();
updateButtonStates();
checkAuth();
