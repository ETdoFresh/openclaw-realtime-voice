# OpenClaw Realtime Voice

A production-ready voice interface for OpenClaw using OpenAI's Realtime API with WebRTC, built with TypeScript and Vite.

## Overview

This is the **production-ready** OpenClaw realtime voice interface that provides:
- Real-time voice conversations with OpenAI's Realtime API
- Integration with OpenClaw Gateway for task processing
- Advanced UI with audio visualization, conversation transcript, and task tracking
- Production security features (token auth, rate limiting, cost tracking)
- Mobile-responsive design with dark theme

**Core principle:** OpenAI Realtime = voice interface (fast, instant). OpenClaw Agent = brain (tools, memory, all capabilities). Voice doesn't think — it relays.

## Architecture

```
Browser (WebRTC) ←→ OpenAI Realtime API
    ↓ (function calls)
Node.js Server (Express + WebSocket)
    ↓ (authenticated connection)
OpenClaw Gateway ←→ OpenClaw Agent (Claude)
```

## Features

### Voice Interface
- Real-time voice conversation using OpenAI's `gpt-4o-realtime-preview` model
- Voice selection (Alloy, Ash, Ballad, Cedar, Coral, Marin, Sage, Verse)
- Speaking speed control (Very Slow to Very Fast)
- Mute/unmute toggle
- Barge-in support (interrupt bot mid-response)

### Advanced UI
- **Audio Visualizer**: Real-time frequency visualization of audio input
- **Conversation Transcript**: Collapsible sidebar with full conversation history
- **Task Status Tracker**: Visual feedback for OpenClaw tasks (spinner → checkmark)
- **Mobile-responsive**: Works seamlessly on desktop, tablet, and mobile
- **Dark Theme**: Eye-friendly default theme

### Production Features
- **Token-based Authentication**: Bearer token auth for API routes
- **Rate Limiting**: 30 requests/minute per IP on `/api/send`
- **Cost Tracking**: Monitor OpenAI Realtime session duration and estimated costs
- **Health Monitoring**: `/api/health` and `/api/stats` endpoints
- **WebSocket Notifications**: Proactive notifications from OpenClaw Gateway

## Setup

### Prerequisites

- Node.js 18+ (for ES modules support)
- OpenAI API key with Realtime API access
- OpenClaw Gateway URL and authentication token
- Modern browser with WebRTC support (Chrome, Firefox, Edge, Safari)

### Installation

1. Clone or navigate to the repository:
   ```bash
   cd openclaw-realtime-voice
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create `.env` file:
   ```bash
   cp .env.example .env
   ```

4. Edit `.env` and configure:
   ```env
   OPENAI_API_KEY=sk-proj-...
   PORT=3335
   OPENCLAW_GATEWAY_URL=wss://openclaw.etdofresh.com
   OPENCLAW_GATEWAY_TOKEN=your_gateway_token_here
   OPENCLAW_SESSION_KEY=realtime-voice:ET
   VOICE_AUTH_TOKEN=your_secure_token_here  # Optional, for production
   ```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | - | OpenAI API key with Realtime API access |
| `PORT` | No | 3335 | Server port |
| `OPENCLAW_GATEWAY_URL` | No | `wss://openclaw.etdofresh.com` | OpenClaw Gateway WebSocket URL |
| `OPENCLAW_GATEWAY_TOKEN` | Yes | - | Authentication token for gateway |
| `OPENCLAW_SESSION_KEY` | No | `realtime-voice:ET` | Session key for conversation continuity |
| `VOICE_AUTH_TOKEN` | No | - | Bearer token for API auth (production security) |

**Security Note:** Generate a secure `VOICE_AUTH_TOKEN` with:
```bash
openssl rand -base64 32
```

If `VOICE_AUTH_TOKEN` is not set, authentication is disabled (development mode).

## Running the Application

### Development Mode

Start both the backend server and Vite dev server with hot module replacement:

```bash
npm run dev
```

This starts:
- Backend server on `http://localhost:3335` (API endpoints and WebSocket)
- Vite dev server on `http://localhost:5173` (frontend with HMR)

Open your browser to:
```
http://localhost:5173
```

The Vite dev server automatically proxies `/api` and `/ws` requests to the backend server.

### Production Build

1. Build both frontend and backend:
   ```bash
   npm run build
   ```

   This will:
   - Build the frontend to `dist/public/`
   - Compile the TypeScript backend to `server/dist/`

2. Start the production server:
   ```bash
   npm start
   ```

   Or with PM2 for process management:
   ```bash
   pm2 start server/dist/index.js --name openclaw-voice
   ```

3. Open your browser to:
   ```
   http://localhost:3335
   ```

### Usage

1. Click **Connect** button
2. Allow microphone access when prompted
3. Wait for "Connected - Speak now" status
4. Start talking to the voice agent
5. Try various commands:
   - Simple conversation: "Hello", "What time is it?"
   - OpenClaw tasks: "Check my Discord messages", "What's the weather?", "Set a reminder"
6. Use the **Mute** button to toggle microphone
7. View conversation history in the **Transcript** sidebar
8. Monitor task progress in the **Task Status** area
9. Click **Disconnect** when done

## API Reference

### `POST /api/token`

Generate an OpenAI ephemeral client token for WebRTC connection.

**Authentication:** Bearer token (if `VOICE_AUTH_TOKEN` is set)

**Request:**
```json
{
  "voice": "coral"
}
```

**Response:**
```json
{
  "token": "ek_...",
  "sessionId": "token_..."
}
```

### `POST /api/send`

Send a message from the voice agent to OpenClaw for processing.

**Authentication:** Bearer token (if `VOICE_AUTH_TOKEN` is set)
**Rate Limit:** 30 requests/minute per IP

**Request:**
```json
{
  "message": "Check my Discord messages",
  "sessionId": "session_..."
}
```

**Response:**
```json
{
  "taskId": "task_..."
}
```

### `GET /api/health`

Health check endpoint.

**Authentication:** None

**Response:**
```json
{
  "status": "ok",
  "gatewayConnected": true,
  "activeClients": 2
}
```

### `GET /api/stats`

Cost tracking and session statistics.

**Authentication:** Bearer token (if `VOICE_AUTH_TOKEN` is set)

**Response:**
```json
{
  "activeSessions": 1,
  "completedSessions": 5,
  "totalSessionDurationMs": 1800000,
  "totalDurationMinutes": "30.00",
  "estimatedCostUSD": "$2.00",
  "sessions": {
    "active": [...],
    "completed": [...]
  }
}
```

### `WebSocket /ws`

WebSocket connection for receiving async results and notifications.

**Client → Server:**
```json
{
  "type": "register",
  "sessionId": "session_..."
}
```

**Server → Client (Result):**
```json
{
  "type": "result",
  "taskId": "task_...",
  "text": "Your Discord update: 3 new messages...",
  "error": false
}
```

**Server → Client (Notification):**
```json
{
  "type": "notification",
  "text": "Reminder: Meeting in 5 minutes",
  "timestamp": 1234567890
}
```

## Production Deployment

### Using Traefik for HTTPS

OpenClaw Realtime Voice works seamlessly behind Traefik reverse proxy for HTTPS termination.

**Example `docker-compose.yml` labels:**

```yaml
services:
  openclaw-voice:
    image: openclaw-realtime-voice:latest
    environment:
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}
      - VOICE_AUTH_TOKEN=${VOICE_AUTH_TOKEN}
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.voice.rule=Host(`voice.yourdomain.com`)"
      - "traefik.http.routers.voice.entrypoints=websecure"
      - "traefik.http.routers.voice.tls.certresolver=letsencrypt"
      - "traefik.http.services.voice.loadbalancer.server.port=3335"
    networks:
      - traefik-net
```

**Important Notes:**
- WebRTC requires HTTPS in production (except localhost)
- WebSocket connections (`/ws`) work automatically with Traefik
- Set `VOICE_AUTH_TOKEN` for production security
- Use proper CORS configuration if needed

### Environment Security

In production:
1. **Always set `VOICE_AUTH_TOKEN`** to a strong random value
2. Keep `.env` file secure and out of version control
3. Use environment variable management (Docker secrets, Kubernetes secrets, etc.)
4. Monitor `/api/stats` for usage and costs
5. Adjust rate limits as needed in `server/index.ts`

### Cost Management

OpenAI Realtime API costs approximately **$4/hour** for active conversation time.

Monitor costs with:
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" https://voice.yourdomain.com/api/stats
```

Tips to reduce costs:
- Disconnect when not actively using
- Monitor `totalDurationMinutes` regularly
- Set up alerts for unusual usage patterns

## Project Structure

```
.
├── public/
│   ├── index.html         # HTML entry point
│   └── src/
│       ├── main.ts        # Frontend TypeScript
│       └── style.css      # Styles (dark theme, responsive)
├── server/
│   ├── index.ts           # Express + WebSocket server
│   ├── tsconfig.json      # Server TypeScript config
│   └── dist/              # Compiled server code
├── dist/
│   └── public/            # Built frontend assets
├── vite.config.ts         # Vite configuration
├── tsconfig.json          # Frontend TypeScript config
├── package.json           # Dependencies and scripts
├── .env                   # Environment variables (not in git)
├── .env.example           # Environment template
├── README.md              # This file
├── PLAN.md                # Implementation roadmap
└── architecture.md        # Architecture diagrams

```

## How It Works

### Voice Agent Behavior

The OpenAI Realtime voice agent follows these rules:
- **Instant responses** for simple conversation (greetings, time, small talk)
- **Delegates to OpenClaw** for anything requiring tools, lookups, or actions
- **Speaks results** when they arrive asynchronously via WebSocket
- **Handles interruptions** gracefully with barge-in support

### Function Tool: `send_to_openclaw`

When the voice agent determines a task requires OpenClaw:
1. Calls `send_to_openclaw(message)` with the user's full request
2. POST to `/api/send` returns a `taskId` immediately
3. Task appears in UI with pending spinner
4. Server processes via OpenClaw Gateway
5. Result pushed via WebSocket
6. Task updates to checkmark (or error icon)
7. Frontend injects result into conversation
8. Voice agent speaks the result

### Barge-in Handling

When a user starts speaking while the bot is responding:
1. Frontend detects `input_audio_buffer.speech_started` event
2. Sends `response.cancel` to OpenAI Realtime API
3. Current response is interrupted
4. User's new input is processed immediately

## Troubleshooting

### "Failed to get token" error
- Verify your `OPENAI_API_KEY` in `.env` is correct
- Check that your OpenAI account has Realtime API access
- Ensure no rate limits are being hit

### "Unauthorized" error
- Check that `VOICE_AUTH_TOKEN` matches between server and client
- Include `Authorization: Bearer TOKEN` header in requests
- Or disable auth by removing `VOICE_AUTH_TOKEN` from `.env`

### Microphone not working
- Ensure you're accessing via `https://` or `localhost` (required for WebRTC)
- Check browser permissions for microphone access
- Try a different browser if issues persist
- Check browser console for WebRTC errors

### WebSocket connection fails
- Check that the server is running on the expected port
- Verify no firewall is blocking WebSocket connections
- Check browser console for WebSocket errors
- Ensure Traefik is properly configured for WebSocket upgrade

### No audio output
- Check your system audio settings
- Ensure the correct output device is selected in your browser
- Try refreshing the page
- Check browser console for audio playback errors

### Rate limit errors
- Default limit is 30 requests/minute per IP
- Wait for the rate limit window to reset
- Adjust `RATE_LIMIT_MAX` in `server/index.ts` if needed

### Gateway connection issues
- Verify `OPENCLAW_GATEWAY_URL` and `OPENCLAW_GATEWAY_TOKEN`
- Check server logs for gateway connection status
- Use `/api/health` to check gateway connection status

## Development

### Adding New Features

1. **Frontend changes:** Edit `public/src/main.ts` and `public/src/style.css`
2. **Backend changes:** Edit `server/index.ts`
3. **Test in dev mode:** `npm run dev`
4. **Build for production:** `npm run build`

### Testing

```bash
# Development
npm run dev

# Build
npm run build

# Production
npm start
```

### Debugging

Enable verbose logging by checking the browser console and server logs:
- Browser: Open DevTools → Console
- Server: Check terminal output or logs

## License

ISC

## Credits

Built for OpenClaw by ETdoFresh
Powered by OpenAI Realtime API
