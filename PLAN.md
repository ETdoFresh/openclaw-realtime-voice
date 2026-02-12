# Realtime Voice Channel — Implementation Plan

## Overview
A new OpenClaw channel plugin that provides a browser-based real-time voice interface. 
Uses OpenAI's Realtime API (WebRTC, speech-to-speech) for instant voice conversation, 
with function calls delegating tasks to OpenClaw's agent (Claude) asynchronously.

## Architecture
See `architecture.md` for diagrams and sequence flows.

**Core principle:** OpenAI Realtime = voice interface (fast, instant). 
OpenClaw Agent = brain (tools, memory, all capabilities). 
Voice doesn't think — it relays.

---

## Phase 1: Standalone Prototype (no plugin, just works)
**Goal:** Get voice ↔ OpenClaw working end-to-end in the simplest way possible.

### 1.1 Backend Server (Node.js/Express)
- [ ] `server.ts` — Express server on configurable port
- [ ] `POST /api/token` — Generate OpenAI ephemeral client token
  - Calls `POST https://api.openai.com/v1/realtime/client_secrets`
  - Requires `OPENAI_API_KEY` env var
  - Returns `{ token: "ek_..." }`
- [ ] `POST /api/send` — Receive messages from voice agent
  - Accepts `{ message: string, sessionId: string }`
  - Runs message through OpenClaw agent (via gateway RPC or direct)
  - Returns `{ taskId: string }` immediately (async)
- [ ] `GET /api/result/:taskId` — Poll for task result (simple polling first)
- [ ] `WS /ws` — WebSocket for pushing results back to frontend
  - Message format: `{ type: "result", taskId, text }`
- [ ] Serve static frontend files

### 1.2 Frontend (HTML + JS)
- [ ] `index.html` — Single page app
- [ ] Connect button → fetch ephemeral token → create RealtimeSession
- [ ] RealtimeAgent with system prompt + `send_to_openclaw` tool definition
- [ ] Tool definition:
  ```js
  {
    name: "send_to_openclaw",
    description: "Send a task or question to OpenClaw for processing. Use for anything requiring tools, lookups, memory, file access, or actions.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "The user's full request, as-is" }
      },
      required: ["message"]
    }
  }
  ```
- [ ] Tool handler: POST to `/api/send`, open WebSocket for results
- [ ] On WebSocket result: inject as conversation item so Realtime speaks it
- [ ] Disconnect button, status indicator, minimal UI

### 1.3 OpenClaw Bridge (simplest path)
- [ ] Option A: Use `sessions_send` to message the main session
- [ ] Option B: Use gateway WebSocket RPC directly
- [ ] Option C: Use `runEmbeddedPiAgent()` like voice-call does (most integrated)
- **Start with Option A** (simplest), upgrade to C later

### Deliverable
A working prototype: open browser → click connect → talk → voice delegates to OpenClaw → results spoken back.

---

## Phase 2: Plugin Integration
**Goal:** Package as a proper OpenClaw plugin (like voice-call, discord, telegram).

### 2.1 Plugin Structure
```
extensions/realtime-voice/
├── openclaw.plugin.json          # Plugin manifest
├── index.ts                      # Plugin entry (register channel, services, tools)
├── package.json                  # Dependencies (@openai/agents, express, ws)
├── src/
│   ├── config.ts                 # Plugin config schema (port, auth, model)
│   ├── server.ts                 # HTTP + WebSocket server
│   ├── bridge.ts                 # OpenClaw agent bridge (runEmbeddedPiAgent)
│   ├── session.ts                # Session management (per-user voice sessions)
│   └── types.ts                  # Shared types
├── public/
│   ├── index.html                # Voice chat UI
│   ├── app.js                    # Frontend logic
│   └── style.css                 # Minimal styling
└── skills/
    └── realtime-voice/
        └── SKILL.md              # Agent skill doc
```

### 2.2 Plugin Registration
- [ ] `api.registerChannel()` — Register as a real OpenClaw channel
  - Messages from voice show up in session history
  - Agent responses route back through the voice channel
- [ ] `api.registerService()` — Start/stop the HTTP/WS server with gateway
- [ ] `api.registerGatewayMethod()` — RPC methods:
  - `realtime-voice.status` — connection status
  - `realtime-voice.sessions` — active voice sessions
- [ ] `api.registerTool()` — Optional: let agent initiate voice (future)

### 2.3 Config Schema
```json5
{
  plugins: {
    entries: {
      "realtime-voice": {
        enabled: true,
        config: {
          port: 3335,
          bind: "127.0.0.1",
          model: "gpt-realtime-mini",    // or "gpt-realtime"
          systemPrompt: "...",            // customizable
          auth: {
            mode: "token",               // reuse gateway token
          }
        }
      }
    }
  }
}
```

### 2.4 Agent Bridge (full integration)
- [ ] Use `runEmbeddedPiAgent()` (same as voice-call extension)
- [ ] Session key: `realtime-voice:{userId}`
- [ ] Full tool access, workspace, memory
- [ ] Response streamed back via WebSocket → spoken by Realtime agent

### Deliverable
Installable OpenClaw plugin. `openclaw plugins install ./extensions/realtime-voice` → restart → configure → open browser → talk.

---

## Phase 3: Polish & Features
**Goal:** Production-quality voice channel.

### 3.1 UI Improvements
- [ ] Visual waveform / audio level indicator
- [ ] Conversation transcript sidebar (text log of what was said)
- [ ] Task status indicators (pending → complete)
- [ ] Mobile-responsive design
- [ ] Dark/light theme

### 3.2 Session Management
- [ ] Persistent sessions (reconnect without losing context)
- [ ] Session timeout / auto-disconnect
- [ ] Multiple concurrent users (if needed)

### 3.3 Advanced Features
- [ ] Barge-in handling (interrupt while result is being spoken)
- [ ] Priority queue (urgent results interrupt, low-priority waits)
- [ ] Voice activity indicator (show when user/bot is speaking)
- [ ] Configurable voice (OpenAI voice selection)
- [ ] Cost tracking / usage display

### 3.4 Security
- [ ] HTTPS enforcement (WebRTC requires secure context)
- [ ] Token rotation for ephemeral keys
- [ ] Rate limiting
- [ ] Allowlist (reuse OpenClaw's DM policy)

### 3.5 Expose via Traefik
- [ ] Add Traefik route for the voice app
- [ ] HTTPS termination (required for WebRTC mic access)
- [ ] WebSocket pass-through for notifications

---

## Tech Stack
- **Frontend:** Vanilla HTML/JS + `@openai/agents` SDK (or direct WebRTC)
- **Backend:** Node.js (runs in Gateway process via plugin)
- **Voice Model:** `gpt-realtime-mini` (cost-effective, ~$4/hr)
- **Agent:** Claude via `runEmbeddedPiAgent()` (full OpenClaw integration)
- **Transport:** WebRTC (browser↔OpenAI), WebSocket (browser↔plugin), HTTP (token/send)

## Dependencies
- `@openai/agents` (or `@openai/agents-realtime` standalone)
- `express` (HTTP server, already in OpenClaw deps)
- `ws` (WebSocket, already in OpenClaw deps)
- `OPENAI_API_KEY` (already configured)

## Cost Estimate
- **gpt-realtime-mini:** ~$4/hr active conversation
- **gpt-realtime:** ~$12/hr active conversation
- **Claude (agent work):** Standard token costs per delegated task
- **Recommendation:** Start with mini, upgrade if voice quality needs it

## Timeline Estimate
- **Phase 1 (Prototype):** 1-2 sessions — get it working end-to-end
- **Phase 2 (Plugin):** 2-3 sessions — proper integration
- **Phase 3 (Polish):** Ongoing — iterate based on usage

## Open Questions
1. Should the voice app be accessible externally (via Traefik) or local-only?
2. Do we want multi-user support or single-user only?
3. Should voice sessions share context with Telegram/Discord sessions or be separate?
4. Do we want the voice agent to have any direct capabilities (time, basic math) or delegate everything?
