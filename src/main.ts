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

// System prompt from architecture.md
const SYSTEM_PROMPT = `You are a voice interface for OpenClaw, an AI assistant system.
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

// DOM elements
const statusIndicator = document.getElementById('statusIndicator') as HTMLDivElement;
const statusText = document.getElementById('statusText') as HTMLDivElement;
const logDiv = document.getElementById('log') as HTMLDivElement;
const connectBtn = document.getElementById('connectBtn') as HTMLButtonElement;
const disconnectBtn = document.getElementById('disconnectBtn') as HTMLButtonElement;

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

    // Fetch ephemeral token
    const tokenResponse = await fetch('/api/token', { method: 'POST' });
    if (!tokenResponse.ok) {
      throw new Error('Failed to get token');
    }
    const { token } = await tokenResponse.json() as TokenResponse;
    log('Token received', 'success');

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
        log(`Task result: ${data.text}`, 'task');
        // Inject result as conversation item
        if (dc && dc.readyState === 'open') {
          const responseEvent = {
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [{
                type: 'input_text',
                text: `[OpenClaw result] ${data.text}`
              }]
            }
          };
          dc.send(JSON.stringify(responseEvent));
          dc.send(JSON.stringify({ type: 'response.create' }));
        }
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

    // Add audio track
    stream.getTracks().forEach(track => pc!.addTrack(track, stream));

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
          instructions: SYSTEM_PROMPT,
          modalities: ['audio', 'text'],
          voice: 'verse',
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

      setStatus('connected', 'Connected - Speak now');
      disconnectBtn.disabled = false;
    };

    dc.onmessage = async (event: MessageEvent) => {
      const msg = JSON.parse(event.data) as DataChannelMessage;

      // Log important events
      if (msg.type === 'response.done') {
        log('Response completed', 'info');
      } else if (msg.type === 'conversation.item.created') {
        if (msg.item?.type === 'function_call') {
          log(`Tool called: ${msg.item.name}`, 'task');
        }
      } else if (msg.type === 'response.function_call_arguments.done') {
        // Handle function call
        const { name, call_id, arguments: args } = msg;
        if (name === 'send_to_openclaw' && args) {
          const params = JSON.parse(args);
          log(`Sending to OpenClaw: "${params.message}"`, 'task');

          // Call backend
          try {
            const response = await fetch('/api/send', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                message: params.message,
                sessionId
              })
            });
            const { taskId } = await response.json() as SendResponse;
            log(`Task queued: ${taskId}`, 'success');

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
    const sdpResponse = await fetch('https://api.openai.com/v1/realtime', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/sdp'
      },
      body: offer.sdp
    });

    if (!sdpResponse.ok) {
      throw new Error('Failed to connect to OpenAI Realtime API');
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
  }
}

// Disconnect function
function disconnect(): void {
  log('Disconnecting...', 'info');
  cleanup();
  setStatus('', 'Disconnected');
  connectBtn.disabled = false;
  disconnectBtn.disabled = true;
}

// Cleanup function
function cleanup(): void {
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
}

// Attach event listeners
connectBtn.addEventListener('click', connect);
disconnectBtn.addEventListener('click', disconnect);

// Initial log
log('Ready to connect', 'info');
