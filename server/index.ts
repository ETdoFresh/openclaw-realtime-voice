import express, { Request, Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer, Server as HTTPServer } from 'http';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// OpenClaw Gateway Configuration
const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'wss://openclaw.etdofresh.com';
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';
const SESSION_KEY = process.env.OPENCLAW_SESSION_KEY || 'realtime-voice:ET';
const GATEWAY_TIMEOUT = 30000; // 30 seconds timeout for responses
const RECONNECT_DELAY = 5000; // 5 seconds between reconnection attempts

// Production Configuration
const VOICE_AUTH_TOKEN = process.env.VOICE_AUTH_TOKEN || '';
const RATE_LIMIT_MAX = 30; // Max requests per minute
const RATE_LIMIT_WINDOW = 60000; // 1 minute in milliseconds

// Server state (module-level for lifecycle management)
let server: HTTPServer | null = null;
let wss: WebSocketServer | null = null;
let gatewayWs: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let isConnecting = false;

// Store for active client sessions
const sessions = new Map<string, WebSocket>();

// Store for pending gateway requests
interface PendingRequest {
  resolve: (response: string) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}
const pendingRequests = new Map<string, PendingRequest>();

// Track active agent runs: runId -> { taskId, sessionId, text }
interface ActiveRun {
  taskId: string;
  sessionId: string;
  text: string;
}
const activeRuns = new Map<string, ActiveRun>();

// Rate limiting: Track requests per IP
interface RateLimitEntry {
  count: number;
  resetTime: number;
}
const rateLimitMap = new Map<string, RateLimitEntry>();

// Cost tracking: Track OpenAI Realtime session durations
interface SessionCostTracking {
  startTime: number;
  endTime?: number;
  durationMs?: number;
}
const sessionCostTracking = new Map<string, SessionCostTracking>();
let totalSessionDurationMs = 0;

// Gateway WebSocket connection management
function connectToGateway(): void {
  if (isConnecting || (gatewayWs && gatewayWs.readyState === WebSocket.OPEN)) {
    return;
  }

  isConnecting = true;
  console.log('Connecting to OpenClaw gateway...');

  try {
    gatewayWs = new WebSocket(GATEWAY_URL, {
      headers: {
        'Authorization': `Bearer ${GATEWAY_TOKEN}`
      }
    });

    gatewayWs.on('open', () => {
      console.log('Connected to OpenClaw gateway');
      isConnecting = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      // PLUGIN INTEGRATION POINT:
      // When integrated as a plugin, this would call:
      // api.registerChannel('realtime-voice', {
      //   onMessage: (msg) => { /* handle incoming messages */ },
      //   metadata: { type: 'voice', protocol: 'webrtc' }
      // });
    });

    gatewayWs.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        handleGatewayMessage(message);
      } catch (err) {
        console.error('Error parsing gateway message:', err);
      }
    });

    gatewayWs.on('error', (error) => {
      console.error('Gateway WebSocket error:', error);
      isConnecting = false;
    });

    gatewayWs.on('close', () => {
      console.log('Gateway connection closed. Reconnecting...');
      gatewayWs = null;
      isConnecting = false;
      scheduleReconnect();
    });

  } catch (error) {
    console.error('Error connecting to gateway:', error);
    isConnecting = false;
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) {
    return;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToGateway();
  }, RECONNECT_DELAY);
}

function handleGatewayMessage(message: any): void {
  // Suppress noisy tick/health events
  if (message.type === 'event' && (message.event === 'tick' || message.event === 'health')) {
    return;
  }
  console.log('Gateway message received:', JSON.stringify(message, null, 2));

  // Handle connect.challenge — respond with a full connect request per gateway protocol
  if (message.type === 'event' && message.event === 'connect.challenge') {
    const nonce = message.payload?.nonce;
    if (nonce && gatewayWs && gatewayWs.readyState === WebSocket.OPEN) {
      const connectRequest = {
        type: 'req',
        id: `connect_${Date.now()}`,
        method: 'connect',
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: 'gateway-client',
            version: '1.0.0',
            platform: 'linux',
            mode: 'backend'
          },
          role: 'operator',
          scopes: ['operator.read', 'operator.write', 'operator.admin'],
          auth: { token: GATEWAY_TOKEN }
        }
      };
      gatewayWs.send(JSON.stringify(connectRequest));
      console.log('Sent connect request in response to challenge');
    }
    return;
  }

  // Log hello-ok features for debugging available methods
  if (message.type === 'res' && message.ok && message.payload?.type === 'hello-ok') {
    console.log('Available methods:', JSON.stringify(message.payload.features?.methods));
    console.log('Available events:', JSON.stringify(message.payload.features?.events));
  }

  // Handle response to a specific request
  if (message.id && pendingRequests.has(message.id)) {
    const pending = pendingRequests.get(message.id)!;
    clearTimeout(pending.timeout);
    pendingRequests.delete(message.id);

    if (message.error) {
      const errMsg = typeof message.error === 'string' ? message.error : message.error.message || JSON.stringify(message.error);
      pending.reject(new Error(errMsg));
    } else {
      // chat.send returns { status: 'started', runId: '...' }
      // Re-key activeRuns from requestId to the gateway-assigned runId
      const result = message.result || message.payload;
      if (result?.runId && activeRuns.has(message.id)) {
        const run = activeRuns.get(message.id)!;
        activeRuns.delete(message.id);
        activeRuns.set(result.runId, run);
        console.log(`Mapped request ${message.id} -> runId ${result.runId} for task ${run.taskId}`);
      }
      pending.resolve(result || message.response || 'Request processed');
    }
    return;
  }

  // Handle streaming agent events — collect text and forward final result to client
  if (message.type === 'event' && message.event === 'agent') {
    const { runId, stream, data, sessionKey } = message.payload || {};
    if (!runId) return;

    let run = activeRuns.get(runId);

    // If we don't have a tracked run but the sessionKey matches ours,
    // create an ad-hoc entry (handles subagent runs spawned by the gateway)
    if (!run && sessionKey) {
      const normalizedKey = `agent:main:${SESSION_KEY.toLowerCase()}`;
      if (sessionKey === normalizedKey && stream === 'lifecycle' && data?.phase === 'start') {
        // Find the most recent client session to forward results to
        const lastSessionId = Array.from(sessions.keys()).pop();
        if (lastSessionId) {
          const taskId = `subtask_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          run = { taskId, sessionId: lastSessionId, text: '' };
          activeRuns.set(runId, run);
          console.log(`Auto-tracking subagent run ${runId} for session ${lastSessionId}`);
        }
      }
    }

    if (!run) return;

    if (stream === 'assistant' && data?.text) {
      // Update accumulated text (data.text is the full text so far)
      run.text = data.text;
    } else if (stream === 'lifecycle' && data?.phase === 'end') {
      // Agent run finished — send final result to client
      const ws = sessions.get(run.sessionId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'result',
          taskId: run.taskId,
          text: run.text || 'Task completed (no text response)'
        }));
        console.log(`Sent agent result for task ${run.taskId} to session ${run.sessionId}`);
      }
      activeRuns.delete(runId);
    }
    return;
  }

  // Handle proactive notifications from gateway
  if (message.type === 'notification' || message.notification) {
    const notificationText = message.text || message.message || message.notification;
    console.log('Proactive notification from gateway:', notificationText);

    // Broadcast to all connected clients
    for (const [sessionId, clientWs] of sessions.entries()) {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({
          type: 'notification',
          text: notificationText,
          timestamp: Date.now()
        }));
        console.log(`Sent notification to session ${sessionId}`);
      }
    }
  }
}

function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

async function sendToGateway(message: string, requestId?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!gatewayWs || gatewayWs.readyState !== WebSocket.OPEN) {
      reject(new Error('Gateway not connected'));
      return;
    }

    if (!requestId) requestId = generateRequestId();
    const id = requestId;

    // Set timeout for request
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error('Gateway request timeout'));
    }, GATEWAY_TIMEOUT);

    // Store pending request
    pendingRequests.set(requestId, { resolve, reject, timeout });

    // PLUGIN INTEGRATION POINT:
    // When integrated as a plugin, messages sent to gateway would include
    // channel metadata to identify source as 'realtime-voice':
    // {
    //   id: requestId,
    //   method: 'process',
    //   channel: 'realtime-voice',  // <-- Channel identifier
    //   params: {
    //     session: SESSION_KEY,
    //     message: message,
    //     metadata: { source: 'voice', timestamp: Date.now() }
    //   }
    // }

    // Send to gateway with protocol v3 request frame format
    const request = {
      type: 'req',
      id: requestId,
      method: 'chat.send',
      params: {
        sessionKey: SESSION_KEY,
        message: message,
        idempotencyKey: requestId
      }
    };

    try {
      gatewayWs!.send(JSON.stringify(request));
      console.log(`Sent request ${requestId} to gateway`);
    } catch (error) {
      clearTimeout(timeout);
      pendingRequests.delete(requestId);
      reject(error);
    }
  });
}

// Authentication middleware
function authMiddleware(req: Request, res: Response, next: Function): void {
  // Skip auth if no token configured (development mode)
  if (!VOICE_AUTH_TOKEN) {
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
    return;
  }

  const token = authHeader.substring(7);
  if (token !== VOICE_AUTH_TOKEN) {
    res.status(401).json({ error: 'Unauthorized: Invalid token' });
    return;
  }

  next();
}

// Rate limiting middleware
function rateLimitMiddleware(req: Request, res: Response, next: Function): void {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();

  let entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetTime) {
    // Create new entry or reset expired entry
    entry = {
      count: 1,
      resetTime: now + RATE_LIMIT_WINDOW
    };
    rateLimitMap.set(ip, entry);
    return next();
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    const resetIn = Math.ceil((entry.resetTime - now) / 1000);
    res.status(429).json({
      error: 'Too many requests',
      message: `Rate limit exceeded. Try again in ${resetIn} seconds.`,
      retryAfter: resetIn
    });
    return;
  }

  entry.count++;
  next();
}

// Clean up old rate limit entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap.entries()) {
    if (now > entry.resetTime) {
      rateLimitMap.delete(ip);
    }
  }
}, RATE_LIMIT_WINDOW);

// Create Express app
function createApp() {
  const app = express();
  app.use(express.json());

  // Serve static files in production
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(join(__dirname, '../dist/public')));
  }

  // Health check endpoint
  app.get('/api/health', (_req: Request, res: Response) => {
    const gatewayConnected = gatewayWs !== null && gatewayWs.readyState === WebSocket.OPEN;
    const activeClients = sessions.size;

    res.json({
      status: 'ok',
      gatewayConnected,
      activeClients
    });
  });

  // Stats endpoint for cost tracking
  app.get('/api/stats', authMiddleware, (_req: Request, res: Response) => {
    const now = Date.now();
    const activeSessions: any[] = [];
    const completedSessions: any[] = [];

    for (const [sessionId, tracking] of sessionCostTracking.entries()) {
      const sessionData = {
        sessionId,
        startTime: new Date(tracking.startTime).toISOString(),
        durationMs: tracking.durationMs || (now - tracking.startTime),
        durationMinutes: ((tracking.durationMs || (now - tracking.startTime)) / 60000).toFixed(2),
        status: tracking.endTime ? 'completed' : 'active'
      };

      if (tracking.endTime) {
        completedSessions.push(sessionData);
      } else {
        activeSessions.push(sessionData);
      }
    }

    const totalDurationMinutes = (totalSessionDurationMs / 60000).toFixed(2);
    const estimatedCostUSD = (parseFloat(totalDurationMinutes) * (4.0 / 60)).toFixed(2); // $4/hour

    res.json({
      activeSessions: activeSessions.length,
      completedSessions: completedSessions.length,
      totalSessionDurationMs,
      totalDurationMinutes,
      estimatedCostUSD: `$${estimatedCostUSD}`,
      sessions: {
        active: activeSessions,
        completed: completedSessions.slice(-10) // Last 10 completed sessions
      }
    });
  });

  // Serve the main page in production
  app.get('/', (_req: Request, res: Response) => {
    if (process.env.NODE_ENV === 'production') {
      res.sendFile(join(__dirname, '../dist/public', 'index.html'));
    } else {
      res.json({ message: 'Server running. Use Vite dev server for development.' });
    }
  });

  interface TokenResponse {
    client_secret: {
      value: string;
      expires_at: number;
    };
  }

  // Generate OpenAI ephemeral client token
  app.post('/api/token', authMiddleware, async (req: Request, res: Response) => {
    try {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
      }

      const voice = req.body?.voice || 'coral';

      const response = await fetch('https://api.openai.com/v1/realtime/sessions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-4o-realtime-preview',
          voice
        })
      });

      if (!response.ok) {
        const error = await response.text();
        console.error('OpenAI API error:', error);
        return res.status(response.status).json({ error: 'Failed to generate token' });
      }

      const data = await response.json() as TokenResponse;

      // Track session start for cost calculation
      const sessionId = `token_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      sessionCostTracking.set(sessionId, {
        startTime: Date.now()
      });

      res.json({
        token: data.client_secret.value,
        sessionId
      });
    } catch (error) {
      console.error('Error generating token:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  interface SendRequest {
    message: string;
    sessionId: string;
  }

  // Receive messages from voice agent and forward to OpenClaw gateway
  app.post('/api/send', authMiddleware, rateLimitMiddleware, async (req: Request<{}, {}, SendRequest>, res: Response) => {
    const { message, sessionId } = req.body;

    if (!message || !sessionId) {
      return res.status(400).json({ error: 'Missing message or sessionId' });
    }

    console.log(`Received message from ${sessionId}: ${message}`);

    // Generate a task ID
    const taskId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Immediately return the task ID
    res.json({ taskId });

    // Generate requestId upfront — it becomes the runId in gateway agent events
    const requestId = generateRequestId();

    // Register the run so streaming agent events get forwarded to this client
    activeRuns.set(requestId, { taskId, sessionId, text: '' });

    // Process asynchronously — chat.send returns { status: 'started' }
    // The actual response streams via 'agent' events, handled in handleGatewayMessage
    (async () => {
      try {
        await sendToGateway(message, requestId);
        console.log(`Gateway accepted task ${taskId} (run ${requestId})`);
      } catch (error) {
        console.error(`Error processing task ${taskId}:`, error);
        activeRuns.delete(requestId);

        const ws = sessions.get(sessionId);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'result',
            taskId,
            text: `Error: ${(error as Error).message}. Please try again.`,
            error: true
          }));
        }
      }
    })();
  });

  // Reset the OpenClaw chat session (clear conversation history)
  app.post('/api/session/reset', authMiddleware, async (_req: Request, res: Response) => {
    if (!gatewayWs || gatewayWs.readyState !== WebSocket.OPEN) {
      return res.status(503).json({ error: 'Gateway not connected' });
    }

    const requestId = generateRequestId();

    const request = {
      type: 'req',
      id: requestId,
      method: 'sessions.reset',
      params: {
        sessionKey: `agent:main:${SESSION_KEY.toLowerCase()}`
      }
    };

    // Wait for the response
    const responsePromise = new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error('Session reset timeout'));
      }, GATEWAY_TIMEOUT);
      pendingRequests.set(requestId, { resolve, reject, timeout });
    });

    try {
      gatewayWs.send(JSON.stringify(request));
      console.log(`Sent session reset request ${requestId}`);
      const result = await responsePromise;
      console.log('Session reset result:', result);
      res.json({ status: 'ok', message: 'Session reset successfully' });
    } catch (error) {
      console.error('Session reset error:', error);
      res.status(500).json({ error: (error as Error).message });
    }
  });

  return app;
}

/**
 * Start the plugin service
 * Called by OpenClaw plugin system on startup
 */
export async function start(port?: number): Promise<void> {
  if (server) {
    console.log('Server already running');
    return;
  }

  const PORT = port || process.env.PORT || 3335;
  const app = createApp();

  // Create HTTP server
  server = createServer(app);

  // Create WebSocket server on /ws path
  wss = new WebSocketServer({
    server,
    path: '/ws'
  });

  // WebSocket connection handling
  wss.on('connection', (ws: WebSocket, _req) => {
    console.log('WebSocket client connected');

    ws.on('message', (message: Buffer) => {
      try {
        const data = JSON.parse(message.toString());
        if (data.type === 'register' && data.sessionId) {
          sessions.set(data.sessionId, ws);
          console.log(`Session ${data.sessionId} registered`);
        }
      } catch (err) {
        console.error('Error parsing WebSocket message:', err);
      }
    });

    ws.on('close', () => {
      // Remove session when client disconnects
      for (const [sessionId, socket] of sessions.entries()) {
        if (socket === ws) {
          sessions.delete(sessionId);
          console.log(`Session ${sessionId} disconnected`);

          // Track session end time for cost calculation
          const tracking = sessionCostTracking.get(sessionId);
          if (tracking && !tracking.endTime) {
            tracking.endTime = Date.now();
            tracking.durationMs = tracking.endTime - tracking.startTime;
            totalSessionDurationMs += tracking.durationMs;
            console.log(`Session ${sessionId} duration: ${(tracking.durationMs / 60000).toFixed(2)} minutes`);
          }
          break;
        }
      }
    });
  });

  // Initialize gateway connection
  connectToGateway();

  // Start server
  await new Promise<void>((resolve) => {
    server!.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
      console.log(`WebSocket server ready`);
      resolve();
    });
  });
}

/**
 * Stop the plugin service
 * Called by OpenClaw plugin system on shutdown
 */
export async function stop(): Promise<void> {
  console.log('Stopping realtime-voice plugin...');

  // Clear reconnect timer
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  // Close gateway connection
  if (gatewayWs) {
    gatewayWs.close();
    gatewayWs = null;
  }

  // Close all client sessions
  for (const [sessionId, ws] of sessions.entries()) {
    console.log(`Closing session ${sessionId}`);
    ws.close();
  }
  sessions.clear();

  // Clear pending requests
  for (const [requestId, pending] of pendingRequests.entries()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error('Server shutting down'));
  }
  pendingRequests.clear();

  // Close WebSocket server
  if (wss) {
    await new Promise<void>((resolve) => {
      wss!.close(() => {
        console.log('WebSocket server closed');
        wss = null;
        resolve();
      });
    });
  }

  // Close HTTP server
  if (server) {
    await new Promise<void>((resolve) => {
      server!.close(() => {
        console.log('HTTP server closed');
        server = null;
        resolve();
      });
    });
  }

  console.log('Realtime-voice plugin stopped');
}

// If run directly (not as a module), start the server
if (import.meta.url === `file://${process.argv[1]}`) {
  const PORT = parseInt(process.env.PORT || '3335', 10);
  start(PORT).catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });

  // Handle graceful shutdown
  const shutdown = async () => {
    console.log('\nReceived shutdown signal');
    await stop();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
