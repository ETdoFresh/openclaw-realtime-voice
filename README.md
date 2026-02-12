# OpenClaw Realtime Voice - Phase 1 Prototype

A standalone prototype for the OpenClaw realtime voice interface using OpenAI's Realtime API.

## Overview

This is **Phase 1** of the realtime voice channel implementation. It provides a browser-based voice interface that:
- Connects directly to OpenAI's Realtime API via WebRTC
- Handles voice conversations with instant responses
- Delegates complex tasks to OpenClaw (mocked in this phase)
- Receives async results via WebSocket

**Core principle:** OpenAI Realtime = voice interface (fast, instant). OpenClaw Agent = brain (tools, memory, all capabilities). Voice doesn't think — it relays.

## Architecture

```
Browser (WebRTC) ←→ OpenAI Realtime API
    ↓ (function calls)
Node.js Server (Express + WebSocket)
    ↓ (mock in Phase 1, real OpenClaw in Phase 2)
OpenClaw Agent (Claude)
```

## Features

- **Voice Interface**: Real-time voice conversation using OpenAI's `gpt-4o-realtime-preview` model
- **Function Calling**: Voice agent can call `send_to_openclaw()` to delegate tasks
- **Async Results**: Results pushed back via WebSocket and spoken by the voice agent
- **Clean UI**: Minimal dark theme with connection status and activity log

## Setup

### Prerequisites

- Node.js 18+ (for ES modules support)
- OpenAI API key with Realtime API access
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

4. Edit `.env` and add your OpenAI API key:
   ```
   OPENAI_API_KEY=sk-proj-...
   PORT=3000
   ```

## Running the Prototype

Start the server:
```bash
npm start
```

Or for development with auto-reload:
```bash
npm run dev
```

Open your browser to:
```
http://localhost:3000
```

### Usage

1. Click **Connect** button
2. Allow microphone access when prompted
3. Wait for "Connected - Speak now" status
4. Start talking to the voice agent
5. Try asking questions that trigger OpenClaw delegation:
   - "Check my Discord messages"
   - "What's the weather?"
   - "Set a reminder for 9am"
6. Click **Disconnect** when done

## How It Works

### Voice Agent Behavior

The OpenAI Realtime voice agent follows these rules:
- **Instant responses** for simple conversation (greetings, time, small talk)
- **Delegates to OpenClaw** for anything requiring tools, lookups, or actions
- **Speaks results** when they arrive asynchronously via WebSocket

### Function Tool: `send_to_openclaw`

When the voice agent determines a task requires OpenClaw:
1. Calls `send_to_openclaw(message)` with the user's full request
2. POST to `/api/send` returns a `taskId` immediately
3. Server processes (currently mocked with 2s delay)
4. Result pushed via WebSocket
5. Frontend injects result into conversation
6. Voice agent speaks the result

### Mock Backend (Phase 1)

The `/api/send` endpoint currently returns a mock response after 2 seconds:
```
Mock response: I received your request "...". In Phase 2, this will be processed by OpenClaw agent.
```

## API Endpoints

### `POST /api/token`
Generate an OpenAI ephemeral client token for WebRTC connection.

**Response:**
```json
{
  "token": "ek_..."
}
```

### `POST /api/send`
Receive a message from the voice agent for OpenClaw processing.

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

### `WebSocket /`
WebSocket connection for receiving async results.

**Client → Server:**
```json
{
  "type": "register",
  "sessionId": "session_..."
}
```

**Server → Client:**
```json
{
  "type": "result",
  "taskId": "task_...",
  "text": "Your Discord update: 3 new messages..."
}
```

## Project Structure

```
.
├── server.js              # Express + WebSocket server
├── package.json           # Dependencies and scripts
├── .env                   # Environment variables (not in git)
├── .env.example           # Template for .env
├── public/
│   └── index.html         # Voice chat UI (single page app)
├── README.md              # This file
├── PLAN.md                # Full implementation plan
└── architecture.md        # Architecture diagrams and flows
```

## Next Steps (Phase 2)

Phase 2 will integrate this prototype as a proper OpenClaw plugin:
- Replace mock backend with real `runEmbeddedPiAgent()` bridge
- Register as an OpenClaw channel
- Full tool access, workspace, and memory
- Multi-session support
- Persistent session management

See `PLAN.md` for the complete roadmap.

## Troubleshooting

### "Failed to get token" error
- Verify your `OPENAI_API_KEY` in `.env` is correct
- Check that your OpenAI account has Realtime API access

### Microphone not working
- Ensure you're accessing via `https://` or `localhost` (required for WebRTC)
- Check browser permissions for microphone access
- Try a different browser if issues persist

### WebSocket connection fails
- Check that the server is running on the expected port
- Verify no firewall is blocking WebSocket connections

### No audio output
- Check your system audio settings
- Ensure the correct output device is selected in your browser
- Try refreshing the page

## Cost Estimate

- **gpt-4o-realtime-preview**: ~$4/hr for active conversation
- **Phase 1 mock**: No additional costs
- **Phase 2 with Claude**: Standard token costs per delegated task

## License

ISC
