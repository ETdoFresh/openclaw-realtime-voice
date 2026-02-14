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
  aiActive: boolean;   // this user has toggled AI active
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
  globalAiActive: boolean; // at least one user has AI active
}

// Single room for now
const room: Room = {
  users: new Map(),
  openaiWs: null,
  openaiConnecting: false,
  openaiSessionConfigured: false,
  voice: 'coral',
  systemPrompt: '',
  globalAiActive: false,
};


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
