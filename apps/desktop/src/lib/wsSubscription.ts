/**
 * Unified WebSocket subscription — a single persistent connection to the gateway's
 * `/api/ws` endpoint that delivers ALL server→client events: turn.* (delta, activity,
 * plan, reasoning, done, queued, retry, error), computer.live, app.event (thread.*,
 * task.*), and resume flow (resume.ack, resume.done).
 *
 * Replaces the fragmented channels: subscribeAppEvents (NDJSON /api/events),
 * listenChatStreamEvent (pub/sub in-process), and the 12 polling setInterval calls.
 *
 * Usage:
 *   wsSubscription.connect();               // at boot
 *   const unsub = wsSubscription.subscribe(handler);  // register a handler
 *   wsSubscription.resume(turnId, lastSeq); // after reconnect
 *   wsSubscription.disconnect();            // at shutdown
 */

import { DESKTOP_GATEWAY_URL } from "./gatewayConfig";

/** A server message received on the WS. The `type` field discriminates. */
export interface ServerMessage {
  type: string;
  [key: string]: unknown;
}

type ServerEventHandler = (msg: ServerMessage) => void;

class WSSubscription {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private handlers = new Set<ServerEventHandler>();
  private lastSeqByTurn = new Map<string, number>();
  private pingTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isConnecting = false;
  private shouldReconnect = true;

  /** Open the WS connection. Called once at boot. Safe to call multiple times. */
  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    if (this.isConnecting) return;
    this.isConnecting = true;
    this.shouldReconnect = true;

    const wsBase = DESKTOP_GATEWAY_URL.replace(/^http/, "ws");
    // The /api/ws route is ungated (like noVNC), so no token needed.
    const url = `${wsBase}/api/ws`;

    try {
      this.ws = new WebSocket(url);
    } catch {
      this.isConnecting = false;
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.isConnecting = false;
      this.reconnectAttempts = 0;
      this.startPingWatchdog();
      console.log("[ws] connected");
    };

    this.ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data) as ServerMessage;
        // Track seq per turn
        if (msg.turn_id && typeof msg.seq === "number") {
          this.lastSeqByTurn.set(msg.turn_id as string, msg.seq as number);
        }
        // Dispatch a tutti i subscriber
        for (const h of this.handlers) {
          try {
            h(msg);
          } catch (e) {
            console.error("[ws] handler error", e);
          }
        }
      } catch {
        // Malformed JSON — ignore
      }
    };

    this.ws.onclose = () => {
      this.isConnecting = false;
      this.stopPingWatchdog();
      console.log("[ws] disconnected");
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      // The close handler will trigger reconnect
      this.ws?.close();
    };
  }

  /** Disconnect and stop reconnecting. Called at shutdown. */
  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopPingWatchdog();
    // Detach handlers before closing: closing a CONNECTING socket fires onerror
    // asynchronously, which would otherwise schedule a reconnect we don't want.
    if (this.ws) {
      this.ws.onopen = this.ws.onmessage = this.ws.onclose = this.ws.onerror = null;
      this.ws.close();
    }
    this.ws = null;
    // Reset the in-flight guard synchronously. Previously this was only cleared by
    // the async onclose handler, so a connect() racing right after disconnect()
    // (e.g. StrictMode remount) saw isConnecting===true and no-op'd forever.
    this.isConnecting = false;
  }

  /**
   * Register a handler for server messages. Returns an unsubscribe function.
   * The handler receives ALL messages — filter by `msg.type` and `msg.turn_id`.
   */
  subscribe(handler: ServerEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** Request replay of turn events with seq > lastSeq, then live continuation. */
  resume(turnId: string): void {
    const since = this.lastSeqByTurn.get(turnId) ?? 0;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "resume", turn_id: turnId, since }));
    }
  }

  /** Get the last seq received for a turn (for resume markers). */
  getLastSeq(turnId: string): number {
    return this.lastSeqByTurn.get(turnId) ?? 0;
  }

  // ── Internals ──

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30000);
    this.reconnectAttempts++;
    console.log(`[ws] reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private startPingWatchdog(): void {
    this.stopPingWatchdog();
    // If no message received in 45s (ping is 30s + 15s tolerance), force reconnect
    this.pingTimeout = setTimeout(() => {
      console.log("[ws] ping timeout — forcing reconnect");
      this.ws?.close();
    }, 45000);
  }

  private stopPingWatchdog(): void {
    if (this.pingTimeout) {
      clearTimeout(this.pingTimeout);
      this.pingTimeout = null;
    }
  }
}

/** Singleton — one WS connection for the whole app. */
export const wsSubscription = new WSSubscription();
