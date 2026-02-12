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
  console.log('Gateway message received:', message);

  // Handle response to a specific request
  if (message.id && pendingRequests.has(message.id)) {
    const pending = pendingRequests.get(message.id)!;
    clearTimeout(pending.timeout);
    pendingRequests.delete(message.id);

    if (message.error) {
      pending.reject(new Error(message.error));
    } else {
      pending.resolve(message.result || message.response || 'Request processed');
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

async function sendToGateway(message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!gatewayWs || gatewayWs.readyState !== WebSocket.OPEN) {
      reject(new Error('Gateway not connected'));
      return;
    }

    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Set timeout for request
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
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

    // Send to gateway with JSON-RPC style format
    const request = {
      id: requestId,
      method: 'process',
      params: {
        session: SESSION_KEY,
        message: message
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
  app.post('/api/token', async (req: Request, res: Response) => {
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
      res.json({ token: data.client_secret.value });
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
  app.post('/api/send', async (req: Request<{}, {}, SendRequest>, res: Response) => {
    const { message, sessionId } = req.body;

    if (!message || !sessionId) {
      return res.status(400).json({ error: 'Missing message or sessionId' });
    }

    console.log(`Received message from ${sessionId}: ${message}`);

    // Generate a task ID
    const taskId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Immediately return the task ID
    res.json({ taskId });

    // Process asynchronously
    (async () => {
      try {
        // Send to OpenClaw gateway
        const response = await sendToGateway(message);
        console.log(`Gateway response for task ${taskId}:`, response);

        // Send result back to client via WebSocket
        const ws = sessions.get(sessionId);
        if (ws && ws.readyState === WebSocket.OPEN) {
          const result = {
            type: 'result',
            taskId,
            text: response
          };
          ws.send(JSON.stringify(result));
          console.log(`Sent result for task ${taskId} to session ${sessionId}`);
        } else {
          console.log(`No active WebSocket for session ${sessionId}`);
        }
      } catch (error) {
        console.error(`Error processing task ${taskId}:`, error);

        // Send error back to client
        const ws = sessions.get(sessionId);
        if (ws && ws.readyState === WebSocket.OPEN) {
          const errorResult = {
            type: 'result',
            taskId,
            text: `Error: ${(error as Error).message}. Please try again.`,
            error: true
          };
          ws.send(JSON.stringify(errorResult));
        }
      }
    })();
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
