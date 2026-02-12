# OpenClaw Realtime Voice Architecture

## Flow Diagram

```
┌─────────────────────────────────────────────────────────┐
│                     BROWSER                              │
│                                                          │
│  🎤 Microphone ──→ WebRTC ──→ OpenAI Realtime API       │
│  🔊 Speaker    ←── WebRTC ←── (gpt-4o-realtime)         │
│                                    │                     │
│  ┌──────────────────────────────────┘                    │
│  │  Voice Agent has tools:                               │
│  │  • send_to_openclaw(message) ──────────────┐          │
│  │  • check_openclaw_status() ────────────────┤          │
│  │                                            │          │
│  │  Receives async results:                   │          │
│  │  ← notification_queue (polled/pushed)      │          │
│  └────────────────────────────────────────────│──────    │
└───────────────────────────────────────────────│──────────┘
                                                │
                                    ┌───────────▼──────────┐
                                    │   PLUGIN BACKEND     │
                                    │   (in Gateway)       │
                                    │                      │
                                    │  HTTP/WS Server      │
                                    │  • POST /voice/send  │
                                    │  • GET  /voice/status│
                                    │  • WS   /voice/ws    │
                                    │  • GET  /voice/app   │
                                    │                      │
                                    │  Notification Queue  │
                                    │  [result1, result2]  │
                                    └───────────┬──────────┘
                                                │
                                    ┌───────────▼──────────┐
                                    │   OPENCLAW AGENT     │
                                    │   (Claude/Pi Agent)  │
                                    │                      │
                                    │  • Full tool access   │
                                    │  • Memory/workspace   │
                                    │  • Sessions           │
                                    │  • All channels       │
                                    └──────────────────────┘
```

## Sequence: User Asks a Complex Question

```
User (speaking): "Hey, can you check my recent Discord messages?"
         │
         ▼
OpenAI Realtime (instant voice response):
  "Sure, let me check that for you."
         │
         ├──→ function call: send_to_openclaw("Check recent Discord messages")
         │                         │
         │                         ▼
         │              Plugin Backend queues request
         │                         │
         │                         ▼
         │              OpenClaw Agent runs (Claude)
         │              • Reads Discord messages
         │              • Summarizes them
         │              • Returns: "3 new messages: Bob asked about..."
         │                         │
         │                         ▼
         │              Plugin Backend adds to notification queue
         │
    (meanwhile, user can keep talking about other things)
         │
         ▼
OpenAI Realtime (receives notification):
  "Your Discord update: 3 new messages.
   Bob asked about the project deadline,
   Alice shared a link, and Charlie said hi."
```

## Sequence: Quick Conversational Exchange

```
User: "What time is it?"
         │
         ▼
OpenAI Realtime (instant, no function call needed):
  "It's 12:31 AM Central time."
```

## Sequence: Multiple Tasks (Single Delegation)

```
User: "Check my weather and also remind me to call Mom at 9am"
         │
         ▼
OpenAI Realtime (instant):
  "Got it, one sec."
         │
         ├──→ send_to_openclaw("Check my weather and remind me to call Mom at 9am")
         │         │
         │         ▼
         │    OpenClaw (Claude) handles everything:
         │    • Checks weather
         │    • Sets reminder
         │    • Returns combined summary
         │
    ← notification: "72°F partly cloudy. Reminder set for 9 AM — call Mom."
         │
         ▼
OpenAI Realtime:
  "72 and partly cloudy. Reminder's set for 9 AM to call Mom."
```

**KEY DESIGN RULE:** The Realtime voice agent does NOT split, decompose,
or orchestrate tasks. It recognizes "this is a task" and sends the ENTIRE
user request to OpenClaw as one message. Claude handles all orchestration.

## System Prompt (for OpenAI Realtime Agent)

```
You are a voice interface for OpenClaw, an AI assistant system.
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
- You don't have direct access to these — delegate via send_to_openclaw()
```

## Components to Build

### 1. Web Frontend (`/voice/app`)
- Simple HTML page served by the plugin
- Uses `@openai/agents` SDK with RealtimeAgent + RealtimeSession
- WebRTC connection to OpenAI (browser handles mic/speaker)
- WebSocket connection to plugin backend for notifications
- Ephemeral token fetched from backend on connect

### 2. Plugin Backend (runs in Gateway process)
- HTTP server:
  - `GET /voice/app` → serves the web frontend
  - `POST /voice/token` → generates OpenAI ephemeral token
  - `POST /voice/send` → receives function calls from frontend
  - `GET /voice/status` → health check
- WebSocket server:
  - `/voice/ws` → push notifications back to frontend
- Notification queue per session

### 3. OpenClaw Bridge
- Takes messages from `/voice/send`
- Routes into agent via `runEmbeddedPiAgent()` (same as voice-call does)
- Collects response, pushes to notification queue
- WebSocket delivers notification to frontend → Realtime agent speaks it

### 4. Authentication
- Simple token auth (reuse gateway auth token)
- Or allowlist by IP/session
