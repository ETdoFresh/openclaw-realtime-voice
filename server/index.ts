import express, { Request, Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(join(__dirname, '../dist/public')));
}

// Store for active sessions
const sessions = new Map<string, WebSocket>();

// Create HTTP server
const server = createServer(app);

// Create WebSocket server on /ws path
const wss = new WebSocketServer({
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

// Routes

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

// Receive messages from voice agent (mock implementation)
app.post('/api/send', async (req: Request<{}, {}, SendRequest>, res: Response) => {
  const { message, sessionId } = req.body;

  if (!message || !sessionId) {
    return res.status(400).json({ error: 'Missing message or sessionId' });
  }

  console.log(`Received message from ${sessionId}: ${message}`);

  // Generate a task ID
  const taskId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  // Mock: After 2 seconds, send the result back via WebSocket
  setTimeout(() => {
    const ws = sessions.get(sessionId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      const result = {
        type: 'result',
        taskId,
        text: `Mock response: I received your request "${message}". In Phase 2, this will be processed by OpenClaw agent.`
      };
      ws.send(JSON.stringify(result));
      console.log(`Sent result for task ${taskId}`);
    } else {
      console.log(`No active WebSocket for session ${sessionId}`);
    }
  }, 2000);

  // Immediately return the task ID
  res.json({ taskId });
});

// Start server
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`WebSocket server ready`);
});
