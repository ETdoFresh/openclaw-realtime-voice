import './style.css';

// Type definitions
interface TokenResponse {
  token: string;
}

interface SendResponse {
  taskId: string;
}

interface WebSocketMessage {
  type: string;
  taskId?: string;
  text?: string;
  sessionId?: string;
  timestamp?: number;
  error?: boolean;
}

interface RTCSessionEvent {
  type: string;
  session?: {
    instructions?: string;
    modalities?: string[];
    voice?: string;
    input_audio_format?: string;
    output_audio_format?: string;
    turn_detection?: {
      type: string;
      threshold: number;
      prefix_padding_ms: number;
      silence_duration_ms: number;
    };
    tools?: unknown[];
    temperature?: number;
  };
}

interface DataChannelMessage {
  type: string;
  item?: {
    type: string;
    name?: string;
    role?: string;
    content?: unknown[];
  };
  name?: string;
  call_id?: string;
  arguments?: string;
}

// Speed labels and prompt instructions
const SPEED_OPTIONS = [
  { label: 'Very Slow', instruction: 'SPEAKING PACE: Speak very slowly and deliberately, with long pauses between sentences.' },
  { label: 'Slow', instruction: 'SPEAKING PACE: Speak at a slower-than-normal pace. Take your time with each sentence.' },
  { label: 'Normal', instruction: '' },
  { label: 'Fast', instruction: 'SPEAKING PACE: Speak quickly and efficiently. Keep a brisk pace.' },
  { label: 'Very Fast', instruction: 'SPEAKING PACE: Speak as fast as possible while remaining clear. Be extremely concise and rapid.' },
];

// System prompt from architecture.md
const BASE_SYSTEM_PROMPT = `You are a voice interface for OpenClaw, an AI assistant system.
Your role is to have natural, real-time voice conversations.

BEHAVIOR:
- Respond instantly to simple conversational messages (greetings, time, small talk)
- For ANYTHING that requires action, lookup, tools, memory, or knowledge
  beyond basic conversation: call send_to_openclaw() with the user's
  FULL request as-is. Do NOT break it up or rephrase it.
  Just acknowledge briefly ("Got it" / "One sec") and wait for the result.
- Keep ALL responses to 1-2 sentences. Be brief and natural.
- When delivering background results, read them back concisely.
  Don't add your own commentary — just relay what OpenClaw said.

BACKGROUND TASKS:
- When you call send_to_openclaw(), the request runs asynchronously
- Results come back as notifications — deliver them naturally
  when they arrive, even if the conversation has moved on
- If multiple results arrive, batch them: "Got a few updates for you..."
- If the user is mid-sentence when a result arrives, wait for
  a natural pause before delivering it

TONE:
- Professional, succinct, friendly
- No filler words ("um", "well", "so")
- No over-explaining. State facts directly.
- Match the user's energy — casual if they're casual

CONTEXT:
- User: ET, based in Metairie, LA (CST timezone)
- OpenClaw has access to: Discord, Telegram, weather, web search,
  file system, memory, cron/reminders, and more
- You don't have direct access to these — delegate via send_to_openclaw()`;

function getSystemPrompt(speedIndex: number): string {
  const speedInstruction = SPEED_OPTIONS[speedIndex].instruction;
  if (!speedInstruction) return BASE_SYSTEM_PROMPT;
  return `${BASE_SYSTEM_PROMPT}\n\n${speedInstruction}`;
}

// Tool definition
const TOOL_DEFINITION = {
  type: "function",
  name: "send_to_openclaw",
  description: "Send a task or question to OpenClaw for processing. Use for anything requiring tools, lookups, memory, file access, or actions.",
  parameters: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "The user's full request, as-is"
      }
    },
    required: ["message"]
  }
};

// Global state
let pc: RTCPeerConnection | null = null;
let dc: RTCDataChannel | null = null;
let ws: WebSocket | null = null;
const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
let audioContext: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let microphone: MediaStreamAudioSourceNode | null = null;
let animationFrameId: number | null = null;
let isMuted = true;
let currentResponseId: string | null = null;

// Speech-aware result queue: buffer results while user is speaking
let userSpeaking = false;
let speechPauseTimer: ReturnType<typeof setTimeout> | null = null;
const SPEECH_PAUSE_DELAY_MS = 1500; // Wait 1.5s after speech stops before delivering
interface QueuedResult {
  type: 'result' | 'notification';
  text: string;
  taskId?: string;
  error?: boolean;
}
const pendingResultQueue: QueuedResult[] = [];

// Auth token from sessionStorage
let authToken = sessionStorage.getItem('voiceAuthToken') || '';

// Auth overlay elements
const authOverlay = document.getElementById('authOverlay') as HTMLDivElement;
const authInput = document.getElementById('authInput') as HTMLInputElement;
const authSubmitBtn = document.getElementById('authSubmitBtn') as HTMLButtonElement;
const authError = document.getElementById('authError') as HTMLDivElement;

// Auth functions
async function checkAuth(): Promise<void> {
  try {
    const res = await fetch('/api/auth/status');
    const { authRequired } = await res.json();

    if (!authRequired) {
      // No auth configured on server — skip login
      authOverlay.style.display = 'none';
      return;
    }

    // Auth is required — check if stored token is valid
    if (authToken) {
      const verifyRes = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      if (verifyRes.ok) {
        authOverlay.style.display = 'none';
        return;
      }
      // Token invalid — clear it
      sessionStorage.removeItem('voiceAuthToken');
      authToken = '';
    }

    // Show login overlay
    authOverlay.style.display = 'flex';
  } catch {
    // Can't reach server — hide overlay, will fail on actual API calls
    authOverlay.style.display = 'none';
  }
}

async function submitAuth(): Promise<void> {
  const token = authInput.value.trim();
  if (!token) return;

  authSubmitBtn.disabled = true;
  authError.style.display = 'none';

  try {
    const res = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (res.ok) {
      authToken = token;
      sessionStorage.setItem('voiceAuthToken', token);
      authOverlay.style.display = 'none';
    } else {
      authError.style.display = 'block';
    }
  } catch {
    authError.textContent = 'Connection error';
    authError.style.display = 'block';
  }

  authSubmitBtn.disabled = false;
}

authSubmitBtn.addEventListener('click', submitAuth);
authInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitAuth();
});

// Task tracking
interface Task {
  id: string;
  message: string;
  status: 'pending' | 'completed' | 'error';
  timestamp: number;
}
const activeTasks = new Map<string, Task>();

// Transcript tracking
interface TranscriptEntry {
  role: 'user' | 'assistant' | 'system';
  text: string;
  timestamp: number;
}
const transcript: TranscriptEntry[] = [];

// DOM elements
const statusIndicator = document.getElementById('statusIndicator') as HTMLDivElement;
const statusText = document.getElementById('statusText') as HTMLDivElement;
const logDiv = document.getElementById('log') as HTMLDivElement;
const connectBtn = document.getElementById('connectBtn') as HTMLButtonElement;
const disconnectBtn = document.getElementById('disconnectBtn') as HTMLButtonElement;
const muteBtn = document.getElementById('muteBtn') as HTMLButtonElement;
const voiceSelect = document.getElementById('voiceSelect') as HTMLSelectElement;
const speedRange = document.getElementById('speedRange') as HTMLInputElement;
const speedLabel = document.getElementById('speedLabel') as HTMLSpanElement;
const visualizerCanvas = document.getElementById('visualizer') as HTMLCanvasElement;
const taskStatusDiv = document.getElementById('taskStatus') as HTMLDivElement;
const transcriptSidebar = document.getElementById('transcriptSidebar') as HTMLDivElement;
const transcriptContent = document.getElementById('transcriptContent') as HTMLDivElement;
const transcriptToggle = document.getElementById('transcriptToggle') as HTMLButtonElement;
const newSessionBtn = document.getElementById('newSessionBtn') as HTMLButtonElement;
const showTranscriptBtn = document.getElementById('showTranscriptBtn') as HTMLButtonElement;
const transcriptMuteBtn = document.getElementById('transcriptMuteBtn') as HTMLButtonElement;
const transcriptPttBtn = document.getElementById('transcriptPttBtn') as HTMLButtonElement;
const transcriptConnectBtn = document.getElementById('transcriptConnectBtn') as HTMLButtonElement;

// Speed slider label updates
speedRange.addEventListener('input', () => {
  speedLabel.textContent = SPEED_OPTIONS[Number(speedRange.value)].label;
});

// Sync the floating "show transcript" button visibility with sidebar state
function updateShowTranscriptBtn(): void {
  const isHidden = transcriptSidebar.classList.contains('hidden');
  showTranscriptBtn.classList.toggle('visible', isHidden);
}

// Transcript sidebar toggle (hide)
transcriptToggle.addEventListener('click', () => {
  transcriptSidebar.classList.add('hidden');
  updateShowTranscriptBtn();
});

// Floating button (show)
showTranscriptBtn.addEventListener('click', () => {
  transcriptSidebar.classList.remove('hidden');
  updateShowTranscriptBtn();
});

// Sync the transcript connect button icon, label, and style with connection state
function updateTranscriptConnectBtn(connected: boolean): void {
  transcriptConnectBtn.classList.toggle('connected', connected);
  const iconConnect = transcriptConnectBtn.querySelector('.icon-connect') as SVGElement;
  const connectLabel = transcriptConnectBtn.querySelector('.connect-label') as HTMLElement;
  const disconnectLabel = transcriptConnectBtn.querySelector('.disconnect-label') as HTMLElement;
  if (iconConnect) iconConnect.style.display = connected ? 'none' : '';
  if (connectLabel) connectLabel.style.display = connected ? 'none' : '';
  if (disconnectLabel) disconnectLabel.style.display = connected ? '' : 'none';
  // Swap SVG: show pause icon when connected (reuse the icon-connect svg, hide it; no icon-disconnect svg in new markup)
  // Actually we removed icon-disconnect svg, need to swap the fill
  // Let me just toggle the SVG content
  if (connected) {
    transcriptConnectBtn.querySelector('svg')!.outerHTML =
      `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
  } else {
    transcriptConnectBtn.querySelector('svg')!.outerHTML =
      `<svg class="icon-connect" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
  }
}

// Transcript connect/disconnect button
transcriptConnectBtn.addEventListener('click', () => {
  if (pc) {
    disconnect();
  } else {
    connect();
  }
});

// Initialize button state
updateShowTranscriptBtn();
updateTranscriptConnectBtn(false);

// Audio Visualizer
function setupVisualizer(stream: MediaStream): void {
  audioContext = new AudioContext();
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;

  microphone = audioContext.createMediaStreamSource(stream);
  microphone.connect(analyser);

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
    let barHeight;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      barHeight = (dataArray[i] / 255) * height * 0.8;

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
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }

  if (microphone) {
    microphone.disconnect();
    microphone = null;
  }

  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  // Clear canvas
  const ctx = visualizerCanvas?.getContext('2d');
  if (ctx && visualizerCanvas) {
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, visualizerCanvas.width, visualizerCanvas.height);
  }
}

// Transcript Management
function addToTranscript(role: 'user' | 'assistant' | 'system', text: string): void {
  const entry: TranscriptEntry = {
    role,
    text,
    timestamp: Date.now()
  };

  transcript.push(entry);
  renderTranscript();
}

function renderTranscript(): void {
  transcriptContent.innerHTML = '';

  transcript.forEach(entry => {
    const entryDiv = document.createElement('div');
    entryDiv.className = `transcript-entry ${entry.role}`;

    const roleDiv = document.createElement('div');
    roleDiv.className = 'transcript-role';
    roleDiv.textContent = entry.role;

    const textDiv = document.createElement('div');
    textDiv.className = 'transcript-text';
    textDiv.textContent = entry.text;

    const timeDiv = document.createElement('div');
    timeDiv.className = 'transcript-time';
    timeDiv.textContent = new Date(entry.timestamp).toLocaleTimeString();

    entryDiv.appendChild(roleDiv);
    entryDiv.appendChild(textDiv);
    entryDiv.appendChild(timeDiv);

    transcriptContent.appendChild(entryDiv);
  });

  transcriptContent.scrollTop = transcriptContent.scrollHeight;
}

// Task Status Management
function addTask(taskId: string, message: string): void {
  const task: Task = {
    id: taskId,
    message,
    status: 'pending',
    timestamp: Date.now()
  };

  activeTasks.set(taskId, task);
  renderTaskStatus();
}

function updateTaskStatus(taskId: string, status: 'completed' | 'error'): void {
  const task = activeTasks.get(taskId);
  if (task) {
    task.status = status;
    renderTaskStatus();

    // Remove completed/error tasks after 5 seconds
    setTimeout(() => {
      activeTasks.delete(taskId);
      renderTaskStatus();
    }, 5000);
  }
}

function renderTaskStatus(): void {
  if (activeTasks.size === 0) {
    taskStatusDiv.innerHTML = '<div style="color: #666; text-align: center; padding: 20px;">No active tasks</div>';
    return;
  }

  taskStatusDiv.innerHTML = '';

  activeTasks.forEach(task => {
    const taskDiv = document.createElement('div');
    taskDiv.className = `task-item ${task.status}`;

    const iconDiv = document.createElement('div');
    if (task.status === 'pending') {
      iconDiv.className = 'task-spinner';
    } else if (task.status === 'completed') {
      iconDiv.className = 'task-checkmark';
      iconDiv.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      `;
    } else {
      iconDiv.className = 'task-error-icon';
      iconDiv.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
      `;
    }

    const textDiv = document.createElement('div');
    textDiv.className = 'task-text';
    textDiv.textContent = task.message;

    taskDiv.appendChild(iconDiv);
    taskDiv.appendChild(textDiv);

    taskStatusDiv.appendChild(taskDiv);
  });
}

// Mute functionality — shared logic that syncs both mute buttons
function setMuted(muted: boolean): void {
  isMuted = muted;

  if (pc) {
    const senders = pc.getSenders();
    senders.forEach(sender => {
      if (sender.track && sender.track.kind === 'audio') {
        sender.track.enabled = !isMuted;
      }
    });
  }

  // Sync main mute button
  muteBtn.classList.toggle('muted', isMuted);
  muteBtn.innerHTML = isMuted
    ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
         <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28z"/>
         <path d="M14.98 11.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99z"/>
         <path d="M4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/>
       </svg>`
    : `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
         <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
         <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
       </svg>`;

  // Sync transcript mute button
  transcriptMuteBtn.classList.toggle('muted', isMuted);
  const micOn = transcriptMuteBtn.querySelector('.mic-on') as SVGElement;
  const micOff = transcriptMuteBtn.querySelector('.mic-off') as SVGElement;
  const muteLabel = transcriptMuteBtn.querySelector('.mute-label') as HTMLElement;
  const unmuteLabel = transcriptMuteBtn.querySelector('.unmute-label') as HTMLElement;
  if (micOn) micOn.style.display = isMuted ? 'none' : '';
  if (micOff) micOff.style.display = isMuted ? '' : 'none';
  if (muteLabel) muteLabel.style.display = isMuted ? 'none' : '';
  if (unmuteLabel) unmuteLabel.style.display = isMuted ? '' : 'none';

  log(isMuted ? 'Microphone muted' : 'Microphone unmuted', 'info');
}

function toggleMute(): void {
  setMuted(!isMuted);
}

muteBtn.addEventListener('click', toggleMute);
transcriptMuteBtn.addEventListener('click', toggleMute);

// Push-to-talk: hold to unmute, release to mute
let pttWasMuted = false;
function pttStart(): void {
  pttWasMuted = isMuted;
  if (isMuted) setMuted(false);
  transcriptPttBtn.classList.add('active');
}
function pttEnd(): void {
  if (pttWasMuted) setMuted(true);
  transcriptPttBtn.classList.remove('active');
}

transcriptPttBtn.addEventListener('mousedown', pttStart);
transcriptPttBtn.addEventListener('mouseup', pttEnd);
transcriptPttBtn.addEventListener('mouseleave', pttEnd);
transcriptPttBtn.addEventListener('touchstart', (e) => { e.preventDefault(); pttStart(); });
transcriptPttBtn.addEventListener('touchend', (e) => { e.preventDefault(); pttEnd(); });
transcriptPttBtn.addEventListener('touchcancel', pttEnd);

// Deliver a queued result/notification to the voice agent via data channel
function deliverToVoiceAgent(item: QueuedResult): void {
  if (item.type === 'result') {
    if (item.taskId) {
      updateTaskStatus(item.taskId, item.error ? 'error' : 'completed');
    }
    addToTranscript('system', `Result: ${item.text}`);
  } else {
    addToTranscript('system', `Notification: ${item.text}`);
  }

  if (dc && dc.readyState === 'open') {
    const prefix = item.type === 'result' ? '[OpenClaw result]' : '[OpenClaw notification]';
    dc.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `${prefix} ${item.text}` }]
      }
    }));
    dc.send(JSON.stringify({ type: 'response.create' }));
  }
}

// Flush all queued results (called after user stops speaking + pause)
function flushResultQueue(): void {
  if (pendingResultQueue.length === 0) return;

  log(`Delivering ${pendingResultQueue.length} queued result(s) after speech pause`, 'info');

  // Batch multiple results into one message if >1
  if (pendingResultQueue.length === 1) {
    deliverToVoiceAgent(pendingResultQueue[0]);
  } else {
    const combined = pendingResultQueue.map(r => r.text).join('\n\n');
    deliverToVoiceAgent({
      type: 'result',
      text: `[Multiple updates]\n${combined}`
    });
    // Update individual task statuses
    for (const item of pendingResultQueue) {
      if (item.taskId) {
        updateTaskStatus(item.taskId, item.error ? 'error' : 'completed');
      }
    }
  }

  pendingResultQueue.length = 0;
}

// Enqueue or deliver a result depending on whether user is speaking
function enqueueOrDeliver(item: QueuedResult): void {
  const logType = item.error ? 'error' : 'task';
  log(`${item.type === 'result' ? 'Task result' : 'Notification'}: ${item.text}`, logType);

  if (userSpeaking) {
    log('User is speaking — queuing result for delivery after pause', 'info');
    pendingResultQueue.push(item);
    return;
  }

  deliverToVoiceAgent(item);
}

// Barge-in handling: cancel current response when user starts speaking
function handleBargeIn(): void {
  if (currentResponseId && dc && dc.readyState === 'open') {
    dc.send(JSON.stringify({
      type: 'response.cancel'
    }));
    log('Interrupted current response (barge-in)', 'info');
    currentResponseId = null;
  }
}

// Logging function
function log(message: string, type: 'info' | 'success' | 'error' | 'task' = 'info'): void {
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logDiv.appendChild(entry);
  logDiv.scrollTop = logDiv.scrollHeight;
}

// Status update function
function setStatus(status: '' | 'connected' | 'connecting', text: string): void {
  statusIndicator.className = `status-indicator ${status}`;
  statusText.className = `status-text ${status}`;
  statusText.textContent = text;
}

// Connect function
async function connect(): Promise<void> {
  try {
    log('Requesting ephemeral token...', 'info');
    setStatus('connecting', 'Connecting...');
    connectBtn.disabled = true;

    // Read selected settings
    const selectedVoice = voiceSelect.value;
    const selectedSpeed = Number(speedRange.value);
    log(`Voice: ${selectedVoice}, Speed: ${SPEED_OPTIONS[selectedSpeed].label}`, 'info');

    // Fetch ephemeral token
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    const tokenResponse = await fetch('/api/token', {
      method: 'POST',
      headers,
      body: JSON.stringify({ voice: selectedVoice })
    });
    if (!tokenResponse.ok) {
      throw new Error('Failed to get token');
    }
    const { token } = await tokenResponse.json() as TokenResponse;
    log('Token received', 'success');

    // Fetch model configuration from server
    const configHeaders: Record<string, string> = {};
    if (authToken) {
      configHeaders['Authorization'] = `Bearer ${authToken}`;
    }
    const configResponse = await fetch('/api/config', { headers: configHeaders });
    const configData = configResponse.ok ? await configResponse.json() as { model: string } : { model: 'gpt-4o-mini-realtime' };
    const realtimeModel = configData.model;
    log(`Using model: ${realtimeModel}`, 'info');

    // Connect WebSocket for receiving results
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => {
      log('WebSocket connected', 'success');
      ws!.send(JSON.stringify({ type: 'register', sessionId }));
    };

    ws.onmessage = (event: MessageEvent) => {
      const data = JSON.parse(event.data) as WebSocketMessage;

      if (data.type === 'result') {
        enqueueOrDeliver({
          type: 'result',
          text: data.text || '',
          taskId: data.taskId,
          error: data.error
        });
      } else if (data.type === 'notification') {
        enqueueOrDeliver({
          type: 'notification',
          text: data.text || ''
        });
      }
    };

    ws.onerror = () => {
      log('WebSocket error', 'error');
    };

    // Create RTCPeerConnection
    log('Creating WebRTC connection...', 'info');
    pc = new RTCPeerConnection();

    // Get microphone access
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    log('Microphone access granted', 'success');

    // Setup audio visualizer
    setupVisualizer(stream);

    // Add audio track (start muted)
    stream.getTracks().forEach(track => {
      if (track.kind === 'audio') track.enabled = !isMuted;
      pc!.addTrack(track, stream);
    });

    // Setup audio output
    pc.ontrack = (event: RTCTrackEvent) => {
      const audioEl = new Audio();
      audioEl.srcObject = event.streams[0];
      audioEl.autoplay = true;
      log('Audio output ready', 'success');
    };

    // Create data channel for events
    dc = pc.createDataChannel('oai-events');

    dc.onopen = () => {
      log('Data channel open', 'success');

      // Send session update with instructions and tools
      const sessionUpdate: RTCSessionEvent = {
        type: 'session.update',
        session: {
          instructions: getSystemPrompt(selectedSpeed),
          modalities: ['audio', 'text'],
          voice: selectedVoice,
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500
          },
          tools: [TOOL_DEFINITION],
          temperature: 0.8
        }
      };
      dc!.send(JSON.stringify(sessionUpdate));
      log('Session configured with system prompt and tools', 'success');

      setStatus('connected', isMuted ? 'Connected - Muted' : 'Connected - Speak now');
      disconnectBtn.disabled = false;
      muteBtn.disabled = false;
      newSessionBtn.disabled = false;
      updateTranscriptConnectBtn(true);
      // Sync mute UI (we start muted)
      setMuted(isMuted);
    };

    dc.onmessage = async (event: MessageEvent) => {
      const msg = JSON.parse(event.data) as DataChannelMessage;

      // Log important events
      if (msg.type === 'response.done') {
        log('Response completed', 'info');
        currentResponseId = null;
      } else if (msg.type === 'response.created') {
        currentResponseId = (msg as any).response?.id || Date.now().toString();
      } else if (msg.type === 'input_audio_buffer.speech_started') {
        log('User started speaking', 'info');
        userSpeaking = true;
        if (speechPauseTimer) {
          clearTimeout(speechPauseTimer);
          speechPauseTimer = null;
        }
        handleBargeIn();
        addToTranscript('user', '[Speaking...]');
      } else if (msg.type === 'input_audio_buffer.speech_stopped') {
        log('User stopped speaking', 'info');
        userSpeaking = false;
        // Wait for a natural pause before delivering queued results
        if (pendingResultQueue.length > 0) {
          if (speechPauseTimer) clearTimeout(speechPauseTimer);
          speechPauseTimer = setTimeout(() => {
            speechPauseTimer = null;
            flushResultQueue();
          }, SPEECH_PAUSE_DELAY_MS);
        }
      } else if (msg.type === 'conversation.item.created') {
        if (msg.item?.type === 'function_call') {
          log(`Tool called: ${msg.item.name}`, 'task');
        } else if (msg.item?.type === 'message' && msg.item.role === 'user') {
          const content = (msg.item.content as any)?.[0];
          if (content?.type === 'input_audio' || content?.type === 'input_text') {
            const text = content.transcript || content.text || '[Audio input]';
            addToTranscript('user', text);
          }
        } else if (msg.item?.type === 'message' && msg.item.role === 'assistant') {
          const content = (msg.item.content as any)?.[0];
          if (content?.type === 'text' || content?.transcript) {
            const text = content.text || content.transcript || '[Audio output]';
            addToTranscript('assistant', text);
          }
        }
      } else if (msg.type === 'response.audio_transcript.done') {
        const transcript = (msg as any).transcript;
        if (transcript) {
          addToTranscript('assistant', transcript);
        }
      } else if (msg.type === 'conversation.item.input_audio_transcription.completed') {
        const transcript = (msg as any).transcript;
        if (transcript) {
          addToTranscript('user', transcript);
        }
      } else if (msg.type === 'response.function_call_arguments.done') {
        // Handle function call
        const { name, call_id, arguments: args } = msg;
        if (name === 'send_to_openclaw' && args) {
          const params = JSON.parse(args);
          log(`Sending to OpenClaw: "${params.message}"`, 'task');

          // Call backend
          try {
            const sendHeaders: Record<string, string> = {
              'Content-Type': 'application/json'
            };
            if (authToken) {
              sendHeaders['Authorization'] = `Bearer ${authToken}`;
            }

            const response = await fetch('/api/send', {
              method: 'POST',
              headers: sendHeaders,
              body: JSON.stringify({
                message: params.message,
                sessionId
              })
            });
            const { taskId } = await response.json() as SendResponse;
            log(`Task queued: ${taskId}`, 'success');

            // Add task to tracker
            addTask(taskId, params.message);
            addToTranscript('system', `Task queued: ${params.message}`);

            // Send function result back to OpenAI
            dc!.send(JSON.stringify({
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id,
                output: JSON.stringify({
                  status: 'queued',
                  taskId,
                  message: 'Task submitted to OpenClaw. Result will be delivered shortly.'
                })
              }
            }));
            dc!.send(JSON.stringify({ type: 'response.create' }));
          } catch (error) {
            log(`Error calling backend: ${(error as Error).message}`, 'error');
          }
        }
      }
    };

    // Create offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Send offer to OpenAI
    const sdpResponse = await fetch(`https://api.openai.com/v1/realtime?model=${encodeURIComponent(realtimeModel)}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/sdp'
      },
      body: offer.sdp
    });

    if (!sdpResponse.ok) {
      let detail = `HTTP ${sdpResponse.status} ${sdpResponse.statusText}`;
      try {
        const body = await sdpResponse.text();
        if (body) detail += ` — ${body.slice(0, 500)}`;
      } catch { /* ignore */ }
      throw new Error(`Failed to connect to OpenAI Realtime API: ${detail}`);
    }

    const answer = await sdpResponse.text();
    await pc.setRemoteDescription({
      type: 'answer',
      sdp: answer
    });

    log('Connected to OpenAI Realtime API', 'success');

  } catch (error) {
    log(`Connection error: ${(error as Error).message}`, 'error');
    setStatus('', 'Disconnected');
    connectBtn.disabled = false;
    cleanup();
    updateTranscriptConnectBtn(false);
  }
}

// Disconnect function
function disconnect(): void {
  log('Disconnecting...', 'info');
  cleanup();
  setStatus('', 'Disconnected');
  connectBtn.disabled = false;
  disconnectBtn.disabled = true;
  muteBtn.disabled = true;
  newSessionBtn.disabled = true;
  updateTranscriptConnectBtn(false);
}

// New session: reset OpenClaw history + reconnect OpenAI voice
async function newSession(): Promise<void> {
  log('Resetting session...', 'info');
  newSessionBtn.disabled = true;

  // 1. Reset OpenClaw chat session (clear conversation history)
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

    const res = await fetch('/api/session/reset', { method: 'POST', headers });
    if (res.ok) {
      log('OpenClaw session cleared', 'success');
    } else {
      const err = await res.json();
      log(`OpenClaw reset failed: ${err.error}`, 'error');
    }
  } catch (error) {
    log(`OpenClaw reset error: ${(error as Error).message}`, 'error');
  }

  // 2. Disconnect and reconnect the OpenAI voice session
  cleanup();
  activeTasks.clear();
  renderTaskStatus();
  transcript.length = 0;
  renderTranscript();

  log('Starting fresh session...', 'info');
  await connect();
}

// Cleanup function
function cleanup(): void {
  stopVisualization();

  if (dc) {
    dc.close();
    dc = null;
  }
  if (pc) {
    pc.close();
    pc = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }

  currentResponseId = null;
}

// Attach event listeners
connectBtn.addEventListener('click', connect);
disconnectBtn.addEventListener('click', disconnect);
newSessionBtn.addEventListener('click', newSession);

// Initial log
log('Ready to connect', 'info');

// Initialize task status display
renderTaskStatus();

// Check auth on page load
checkAuth();
