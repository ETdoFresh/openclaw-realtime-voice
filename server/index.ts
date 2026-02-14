import express, { Request, Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer, Server as HTTPServer, IncomingMessage } from 'http';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// OpenClaw Gateway Configuration
const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'wss://openclaw.etdofresh.com';
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';
const SESSION_KEY = process.env.OPENCLAW_SESSION_KEY || 'realtime-voice:ET';
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-mini';
const GATEWAY_TIMEOUT = 30000;
const RECONNECT_DELAY = 5000;

// Session key with suffix
let sessionKeySuffix = 0;
function getSessionKey(): string {
  return sessionKeySuffix === 0 ? SESSION_KEY : `${SESSION_KEY}:${sessionKeySuffix}`;
}

// Production Configuration
const VOICE_AUTH_TOKEN = process.env.VOICE_AUTH_TOKEN || '';
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW = 60000;

// Server state
let server: HTTPServer | null = null;
let wss: WebSocketServer | null = null;
let gatewayWs: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let isConnecting = false;

// ─── Room & User Management ───────────────────────────────────────────

interface RoomUser {
  id: string;
  ws: WebSocket;
  pttActive: boolean;   // this user is holding push-to-talk
  muted: boolean;
}

interface Room {
  users: Map<string, RoomUser>;
  openaiWs: WebSocket | null;
  openaiConnecting: boolean;
  openaiSessionConfigured: boolean;
  voice: string;
  systemPrompt: string;
  // AI auto-connects when users are present
}

// Single room for now
const room: Room = {
  users: new Map(),
  openaiWs: null,
  openaiConnecting: false,
  openaiSessionConfigured: false,
  voice: 'coral',
  systemPrompt: '',
  // AI auto-managed
};

// Speed removed

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

CONTEXT:
- This is a multi-user voice room. Multiple people may be talking.
- User: ET, based in Metairie, LA (CST timezone)
- OpenClaw has access to: Discord, Telegram, weather, web search,
  file system, memory, cron/reminders, and more
- You don't have direct access to these — delegate via send_to_openclaw()

TONE:
- Professional, succinct, friendly
- No filler words ("um", "well", "so")
- No over-explaining. State facts directly.
- Match the user's energy — casual if they're casual`;

function getSystemPrompt(): string {
  return BASE_SYSTEM_PROMPT;
}

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

// ─── Gateway (OpenClaw) connection ────────────────────────────────────

interface PendingRequest {
  resolve: (response: string) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}
const pendingRequests = new Map<string, PendingRequest>();

interface ActiveRun {
  taskId: string;
  text: string;
}
const activeRuns = new Map<string, ActiveRun>();

interface RateLimitEntry { count: number; resetTime: number; }
const rateLimitMap = new Map<string, RateLimitEntry>();

// Cost tracking
interface SessionCostTracking { startTime: number; endTime?: number; durationMs?: number; }
const sessionCostTracking = new Map<string, SessionCostTracking>();
let totalSessionDurationMs = 0;

console.log('Configuration:');
console.log(`  GATEWAY_URL: ${GATEWAY_URL}`);
console.log(`  GATEWAY_TOKEN: ${GATEWAY_TOKEN ? `${GATEWAY_TOKEN.slice(0, 4)}...${GATEWAY_TOKEN.slice(-4)}` : '(not set)'}`);
console.log(`  SESSION_KEY: ${SESSION_KEY}`);
console.log(`  OPENAI_API_KEY: ${process.env.OPENAI_API_KEY ? `${process.env.OPENAI_API_KEY.slice(0, 7)}...${process.env.OPENAI_API_KEY.slice(-4)}` : '(not set)'}`);
console.log(`  REALTIME_MODEL: ${REALTIME_MODEL}`);

function connectToGateway(): void {
  if (isConnecting || (gatewayWs && gatewayWs.readyState === WebSocket.OPEN)) return;
  isConnecting = true;
  console.log('Connecting to OpenClaw gateway...');

  try {
    gatewayWs = new WebSocket(GATEWAY_URL, { headers: { 'Authorization': `Bearer ${GATEWAY_TOKEN}` } });

    gatewayWs.on('open', () => {
      console.log('Connected to OpenClaw gateway');
      isConnecting = false;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    });

    gatewayWs.on('message', (data: Buffer) => {
      try { handleGatewayMessage(JSON.parse(data.toString())); }
      catch (err) { console.error('Error parsing gateway message:', err); }
    });

    gatewayWs.on('error', (error) => { console.error('Gateway WebSocket error:', error); isConnecting = false; });
    gatewayWs.on('close', () => { console.log('Gateway connection closed. Reconnecting...'); gatewayWs = null; isConnecting = false; scheduleReconnect(); });
  } catch (error) { console.error('Error connecting to gateway:', error); isConnecting = false; scheduleReconnect(); }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connectToGateway(); }, RECONNECT_DELAY);
}

function handleGatewayMessage(message: any): void {
  if (message.type === 'event' && (message.event === 'tick' || message.event === 'health')) return;
  console.log('Gateway message:', JSON.stringify(message, null, 2));

  if (message.type === 'event' && message.event === 'connect.challenge') {
    const nonce = message.payload?.nonce;
    if (nonce && gatewayWs && gatewayWs.readyState === WebSocket.OPEN) {
      gatewayWs.send(JSON.stringify({
        type: 'req', id: `connect_${Date.now()}`, method: 'connect',
        params: { minProtocol: 3, maxProtocol: 3, client: { id: 'gateway-client', version: '1.0.0', platform: 'linux', mode: 'backend' }, role: 'operator', scopes: ['operator.read', 'operator.write', 'operator.admin'], auth: { token: GATEWAY_TOKEN } }
      }));
    }
    return;
  }

  if (message.type === 'res' && message.ok && message.payload?.type === 'hello-ok') {
    console.log('Available methods:', JSON.stringify(message.payload.features?.methods));
  }

  if (message.id && pendingRequests.has(message.id)) {
    const pending = pendingRequests.get(message.id)!;
    clearTimeout(pending.timeout);
    pendingRequests.delete(message.id);
    if (message.error) {
      pending.reject(new Error(typeof message.error === 'string' ? message.error : message.error.message || JSON.stringify(message.error)));
    } else {
      const result = message.result || message.payload;
      if (result?.runId && activeRuns.has(message.id)) {
        const run = activeRuns.get(message.id)!;
        activeRuns.delete(message.id);
        activeRuns.set(result.runId, run);
      }
      pending.resolve(result || message.response || 'Request processed');
    }
    return;
  }

  if (message.type === 'event' && message.event === 'agent') {
    const { runId, stream, data, sessionKey } = message.payload || {};
    if (!runId) return;
    let run = activeRuns.get(runId);

    if (!run && sessionKey) {
      const normalizedKey = `agent:main:${getSessionKey().toLowerCase()}`;
      if (sessionKey === normalizedKey && stream === 'lifecycle' && data?.phase === 'start') {
        const taskId = `subtask_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        run = { taskId, text: '' };
        activeRuns.set(runId, run);
      }
    }
    if (!run) return;

    if (stream === 'assistant' && data?.text) { run.text = data.text; }
    else if (stream === 'lifecycle' && data?.phase === 'end') {
      // Broadcast result to all room users
      broadcastToRoom({ type: 'result', taskId: run.taskId, text: run.text || 'Task completed (no text response)' });
      // Also inject into OpenAI conversation
      injectResultIntoOpenAI(run.taskId, run.text || 'Task completed');
      activeRuns.delete(runId);
    }
    return;
  }

  if (message.type === 'notification' || message.notification) {
    const text = message.text || message.message || message.notification;
    broadcastToRoom({ type: 'notification', text, timestamp: Date.now() });
    injectResultIntoOpenAI(null, text);
  }
}

function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

async function sendToGateway(message: string, requestId?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!gatewayWs || gatewayWs.readyState !== WebSocket.OPEN) { reject(new Error('Gateway not connected')); return; }
    if (!requestId) requestId = generateRequestId();
    const id = requestId;
    const timeout = setTimeout(() => { pendingRequests.delete(id); reject(new Error('Gateway request timeout')); }, GATEWAY_TIMEOUT);
    pendingRequests.set(requestId, { resolve, reject, timeout });
    try {
      gatewayWs!.send(JSON.stringify({ type: 'req', id: requestId, method: 'chat.send', params: { sessionKey: getSessionKey(), message, idempotencyKey: requestId } }));
    } catch (error) { clearTimeout(timeout); pendingRequests.delete(requestId); reject(error); }
  });
}

// ─── Broadcast helpers ────────────────────────────────────────────────

function broadcastToRoom(msg: any, excludeUserId?: string): void {
  const data = JSON.stringify(msg);
  for (const [userId, user] of room.users) {
    if (userId === excludeUserId) continue;
    if (user.ws.readyState === WebSocket.OPEN) {
      user.ws.send(data);
    }
  }
}

// ─── OpenAI Realtime WebSocket (server-side) ──────────────────────────

function connectOpenAI(): void {
  if (room.openaiWs || room.openaiConnecting) return;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) { console.error('OPENAI_API_KEY not set'); return; }

  room.openaiConnecting = true;
  room.openaiSessionConfigured = false;
  console.log('Connecting to OpenAI Realtime API...');

  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`;
  const ws = new WebSocket(url, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'OpenAI-Beta': 'realtime=v1',
    }
  });

  ws.on('open', () => {
    console.log('Connected to OpenAI Realtime API');
    room.openaiWs = ws;
    room.openaiConnecting = false;

    // Configure session
    const sessionUpdate = {
      type: 'session.update',
      session: {
        instructions: getSystemPrompt(),
        modalities: ['audio', 'text'],
        voice: room.voice,
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 200,
          silence_duration_ms: 300,
        },
        tools: [TOOL_DEFINITION],
        temperature: 0.8,
      }
    };
    ws.send(JSON.stringify(sessionUpdate));
    room.openaiSessionConfigured = true;
    console.log('OpenAI session configured');
    broadcastToRoom({ type: 'ai-status', connected: true });
  });

  ws.on('message', (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      handleOpenAIMessage(msg);
    } catch (err) {
      // Could be binary audio data
      // OpenAI Realtime API sends JSON messages, audio is base64 in JSON
    }
  });

  ws.on('error', (err) => {
    console.error('OpenAI WS error:', err.message || err);
    room.openaiConnecting = false;
    broadcastToRoom({ type: 'ai-error', error: `Connection failed: ${(err as Error).message || 'unknown'}` });
  });

  ws.on('close', () => {
    console.log('OpenAI WS closed');
    room.openaiWs = null;
    room.openaiConnecting = false;
    room.openaiSessionConfigured = false;
    broadcastToRoom({ type: 'ai-status', connected: false });
  });
}

function disconnectOpenAI(): void {
  if (room.openaiWs) {
    room.openaiWs.close();
    room.openaiWs = null;
    room.openaiSessionConfigured = false;
  }
}

function handleOpenAIMessage(msg: any): void {
  // Forward transcripts and events to all clients
  if (msg.type === 'response.audio.delta') {
    // Audio chunk from AI - broadcast to all clients as binary-compatible base64
    broadcastToRoom({ type: 'ai-audio', audio: msg.delta });
    return;
  }

  if (msg.type === 'response.audio.done') {
    broadcastToRoom({ type: 'ai-audio-done' });
    return;
  }

  if (msg.type === 'response.audio_transcript.delta') {
    broadcastToRoom({ type: 'transcript', role: 'assistant', text: msg.delta, partial: true });
    return;
  }

  if (msg.type === 'response.audio_transcript.done') {
    broadcastToRoom({ type: 'transcript', role: 'assistant', text: msg.transcript, partial: false });
    return;
  }

  if (msg.type === 'conversation.item.input_audio_transcription.completed') {
    broadcastToRoom({ type: 'transcript', role: 'user', text: msg.transcript, partial: false });
    return;
  }

  if (msg.type === 'input_audio_buffer.speech_started') {
    broadcastToRoom({ type: 'speech-started' });
    return;
  }

  if (msg.type === 'input_audio_buffer.speech_stopped') {
    broadcastToRoom({ type: 'speech-stopped' });
    return;
  }

  if (msg.type === 'response.function_call_arguments.done') {
    const { name, call_id, arguments: args } = msg;
    if (name === 'send_to_openclaw' && args) {
      try {
        const params = JSON.parse(args);
        console.log(`Tool call send_to_openclaw: "${params.message}"`);

        const taskId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const requestId = generateRequestId();
        activeRuns.set(requestId, { taskId, text: '' });

        broadcastToRoom({ type: 'task-created', taskId, message: params.message });

        // Send function result back to OpenAI immediately
        if (room.openaiWs && room.openaiWs.readyState === WebSocket.OPEN) {
          room.openaiWs.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id,
              output: JSON.stringify({ status: 'queued', taskId, message: 'Task submitted to OpenClaw. Result will be delivered shortly.' })
            }
          }));
          room.openaiWs.send(JSON.stringify({ type: 'response.create' }));
        }

        // Send to gateway
        sendToGateway(params.message, requestId).catch((err) => {
          console.error(`Gateway error for task ${taskId}:`, err);
          broadcastToRoom({ type: 'result', taskId, text: `Error: ${err.message}`, error: true });
        });
      } catch (err) {
        console.error('Error handling tool call:', err);
      }
    }
    return;
  }

  if (msg.type === 'response.done') {
    broadcastToRoom({ type: 'response-done' });
    return;
  }

  if (msg.type === 'error') {
    console.error('OpenAI error:', msg.error);
    broadcastToRoom({ type: 'ai-error', error: msg.error?.message || 'Unknown error' });
    return;
  }

  // Log other events
  if (msg.type === 'session.created' || msg.type === 'session.updated') {
    console.log(`OpenAI ${msg.type}`);
  }
}

function injectResultIntoOpenAI(taskId: string | null, text: string): void {
  if (!room.openaiWs || room.openaiWs.readyState !== WebSocket.OPEN) return;
  const prefix = taskId ? '[OpenClaw result]' : '[OpenClaw notification]';
  room.openaiWs.send(JSON.stringify({
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: `${prefix} ${text}` }]
    }
  }));
  room.openaiWs.send(JSON.stringify({ type: 'response.create' }));
}

function sendAudioToOpenAI(audioBase64: string): void {
  if (!room.openaiWs || room.openaiWs.readyState !== WebSocket.OPEN) return;
  room.openaiWs.send(JSON.stringify({
    type: 'input_audio_buffer.append',
    audio: audioBase64,
  }));
}

// AI auto-connects when anyone is in the room
function updateAiConnection(): void {
  if (room.users.size > 0 && !room.openaiWs && !room.openaiConnecting) {
    connectOpenAI();
  } else if (room.users.size === 0) {
    disconnectOpenAI();
  }
}

// ─── Auth middleware ──────────────────────────────────────────────────

function authMiddleware(req: Request, res: Response, next: Function): void {
  if (!VOICE_AUTH_TOKEN) return next();
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) { res.status(401).json({ error: 'Unauthorized' }); return; }
  if (authHeader.substring(7) !== VOICE_AUTH_TOKEN) { res.status(401).json({ error: 'Unauthorized' }); return; }
  next();
}

function rateLimitMiddleware(req: Request, res: Response, next: Function): void {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetTime) { rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW }); return next(); }
  if (entry.count >= RATE_LIMIT_MAX) { res.status(429).json({ error: 'Too many requests' }); return; }
  entry.count++;
  next();
}

setInterval(() => { const now = Date.now(); for (const [ip, entry] of rateLimitMap) { if (now > entry.resetTime) rateLimitMap.delete(ip); } }, RATE_LIMIT_WINDOW);

// ─── WebSocket authentication ─────────────────────────────────────────

function authenticateWsRequest(req: IncomingMessage): boolean {
  if (!VOICE_AUTH_TOKEN) return true;
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  return token === VOICE_AUTH_TOKEN;
}

// ─── Express app ──────────────────────────────────────────────────────

function createApp() {
  const app = express();
  app.use(express.json());

  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(join(__dirname, '../../dist/public')));
  }

  app.post('/api/auth/verify', (req: Request, res: Response) => {
    if (!VOICE_AUTH_TOKEN) return res.json({ authenticated: true, authRequired: false });
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.substring(7) !== VOICE_AUTH_TOKEN) {
      return res.status(401).json({ authenticated: false, authRequired: true });
    }
    res.json({ authenticated: true, authRequired: true });
  });

  app.get('/api/auth/status', (_req: Request, res: Response) => {
    res.json({ authRequired: !!VOICE_AUTH_TOKEN });
  });

  app.get('/api/config', authMiddleware, (_req: Request, res: Response) => {
    res.json({ model: REALTIME_MODEL });
  });

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      buildTime: process.env.BUILD_TIME || new Date().toISOString(),
      gatewayConnected: gatewayWs !== null && gatewayWs.readyState === WebSocket.OPEN,
      openaiConnected: room.openaiWs !== null && room.openaiWs.readyState === WebSocket.OPEN,
      activeUsers: room.users.size,
    });
  });

  app.get('/api/stats', authMiddleware, (_req: Request, res: Response) => {
    res.json({
      activeUsers: room.users.size,
      aiAutoConnected: room.users.size > 0,
      openaiConnected: room.openaiWs !== null,
      totalSessionDurationMs,
    });
  });

  app.post('/api/session/reset', authMiddleware, (_req: Request, res: Response) => {
    const oldKey = getSessionKey();
    sessionKeySuffix++;
    const newKey = getSessionKey();
    console.log(`Session reset: "${oldKey}" -> "${newKey}"`);
    activeRuns.clear();
    // Reconnect OpenAI to clear conversation
    disconnectOpenAI();
    if (room.users.size > 0 || room.users.size > 0) {
      connectOpenAI();
    }
    res.json({ status: 'ok', sessionKey: newKey });
  });

  app.get('/', (_req: Request, res: Response) => {
    if (process.env.NODE_ENV === 'production') {
      res.sendFile(join(__dirname, '../../dist/public', 'index.html'));
    } else {
      res.json({ message: 'Server running. Use Vite dev server for development.' });
    }
  });

  return app;
}

// ─── WebSocket client handling ────────────────────────────────────────

function handleClientMessage(userId: string, user: RoomUser, data: any): void {
  switch (data.type) {
    case 'join': {
      // User joined the room - notify others
      if (data.voice) room.voice = data.voice;

      // Send existing user list to the new user
      const existingUsers = Array.from(room.users.keys()).filter(id => id !== userId);
      user.ws.send(JSON.stringify({ type: 'room-users', users: existingUsers }));

      // Notify others
      broadcastToRoom({ type: 'user-joined', userId }, userId);

      // Auto-connect AI when users join
      updateAiConnection();
      user.ws.send(JSON.stringify({ type: 'ai-status', connected: room.openaiWs !== null && room.openaiWs.readyState === WebSocket.OPEN }));
      console.log(`User ${userId} joined room (${room.users.size} users)`);
      break;
    }

    case 'offer':
    case 'answer':
    case 'ice-candidate': {
      // WebRTC signaling relay
      const target = room.users.get(data.targetUserId);
      if (target && target.ws.readyState === WebSocket.OPEN) {
        target.ws.send(JSON.stringify({ ...data, fromUserId: userId }));
      }
      break;
    }

    case 'audio-data': {
      // PCM audio from client - forward to OpenAI
      // Client already gates what it sends (AI mute, PTT, etc.)
      if (!room.openaiWs || room.openaiWs.readyState !== WebSocket.OPEN) {
        // Log occasionally to help debug
        if (!room.openaiWs && Math.random() < 0.01) console.log('Audio received but OpenAI not connected');
        break;
      }
      sendAudioToOpenAI(data.audio);
      break;
    }

    case 'ptt-start': {
      user.pttActive = true;
      // Ensure OpenAI is connected for PTT
      if (!room.openaiWs && !room.openaiConnecting) {
        connectOpenAI();
      }
      console.log(`User ${userId} PTT start`);
      break;
    }

    case 'ptt-stop': {
      user.pttActive = false;
      console.log(`User ${userId} PTT stop`);
      break;
    }

    case 'mute': {
      user.muted = !!data.muted;
      broadcastToRoom({ type: 'user-muted', userId, muted: user.muted }, userId);
      break;
    }

    case 'update-settings': {
      if (data.voice) room.voice = data.voice;
      // Update OpenAI session if connected
      if (room.openaiWs && room.openaiWs.readyState === WebSocket.OPEN) {
        room.openaiWs.send(JSON.stringify({
          type: 'session.update',
          session: {
            instructions: getSystemPrompt(),
            voice: room.voice,
          }
        }));
      }
      break;
    }

    default:
      console.log(`Unknown message type from ${userId}: ${data.type}`);
  }
}

// ─── Server lifecycle ─────────────────────────────────────────────────

export async function start(port?: number): Promise<void> {
  if (server) { console.log('Server already running'); return; }

  const PORT = port || process.env.PORT || 3335;
  const app = createApp();
  server = createServer(app);

  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // Authenticate
    if (!authenticateWsRequest(req)) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    const userId = `user_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const user: RoomUser = { id: userId, ws, pttActive: false, muted: false };
    room.users.set(userId, user);

    // Send userId to client
    ws.send(JSON.stringify({ type: 'welcome', userId }));

    ws.on('message', (message: Buffer) => {
      try {
        const data = JSON.parse(message.toString());
        handleClientMessage(userId, user, data);
      } catch (err) {
        // Could be binary data - ignore
      }
    });

    ws.on('close', () => {
      room.users.delete(userId);
      broadcastToRoom({ type: 'user-left', userId });
      updateAiConnection();
      console.log(`User ${userId} left (${room.users.size} users)`);

      // Disconnect OpenAI if no users left
      if (room.users.size === 0) {
        disconnectOpenAI();
      }
    });
  });

  connectToGateway();

  await new Promise<void>((resolve) => {
    server!.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
      resolve();
    });
  });
}

export async function stop(): Promise<void> {
  console.log('Stopping realtime-voice plugin...');
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (gatewayWs) { gatewayWs.close(); gatewayWs = null; }
  disconnectOpenAI();
  for (const [, user] of room.users) user.ws.close();
  room.users.clear();
  for (const [, pending] of pendingRequests) { clearTimeout(pending.timeout); pending.reject(new Error('Server shutting down')); }
  pendingRequests.clear();
  if (wss) await new Promise<void>(r => wss!.close(() => { wss = null; r(); }));
  if (server) await new Promise<void>(r => server!.close(() => { server = null; r(); }));
  console.log('Stopped');
}

if (import.meta.url === `file://${resolve(process.argv[1])}`) {
  const PORT = parseInt(process.env.PORT || '3335', 10);
  start(PORT).catch((error) => { console.error('Failed to start:', error); process.exit(1); });
  const shutdown = async () => { console.log('\nShutting down...'); await stop(); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
