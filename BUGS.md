# Bug Reports

## BUG-001: Updates override user speech while talking

**Priority:** High
**Status:** Open
**Date:** 2026-02-15

### Description
The system can apply updates (session resets, AI responses, configuration changes) while a user is actively speaking. This interrupts the user's speech and creates a poor experience in the voice interface.

### Expected Behavior
The system should detect when a user is currently speaking and defer any updates until the user finishes. Updates should be queued and applied only after user speech activity ends (e.g., after a silence threshold or VAD indicates end of speech).

### Suggested Implementation
1. Track user speech state via Voice Activity Detection (VAD) or `input_audio_buffer` events
2. Queue incoming updates (session config changes, AI interruptions, resets) while user is speaking
3. Apply queued updates after speech ends (silence detected for ~500ms+)
4. Consider a `userSpeaking` flag on the server side that blocks non-critical updates
5. Critical updates (disconnect, error) should still apply immediately

### Related Issues
- Session reset doesn't notify other clients (no `session-reset` broadcast)
- Race condition with OpenAI session config marked complete before confirmation
- No OpenAI WebSocket reconnection on drop

---
