import {EventEmitter} from 'node:events';
import WebSocket from 'ws';
import {logger} from '../lib/logger.js';

/**
 * How the heartbeat proves the connection is alive:
 * - 'application': send a "ping" text message; the events server replies with a
 *   "pong" text message. This round-trips through the Lambda backend, so it is
 *   true end-to-end liveness. (default)
 * - 'control': send a WebSocket protocol ping frame and wait for a protocol pong.
 *   Behind API Gateway these are answered at the AWS edge, so this only proves
 *   the front door is reachable, not that the Lambda backend is alive.
 */
export enum PingMode {
    Application = 'application',
    Control = 'control',
}

export interface WebSocketManagerOptions {
    url: string;
    reconnectInterval?: number;
    maxReconnectAttempts?: number;
    pingInterval?: number;
    pongTimeout?: number;
    pingMode?: PingMode;
    subscribeWaitMs?: number;
}

export interface PendingSubscription {
    guid: string;
    timestamp: number;
}

export class WebSocketManager extends EventEmitter {
    private ws: WebSocket | null = null;
    private url: string;
    private reconnectInterval: number;
    private maxReconnectAttempts: number;
    private pingInterval: number;
    private pongTimeout: number;
    private pingMode: PingMode;
    private reconnectAttempts = 0;
    private pingTimer?: NodeJS.Timeout;
    private pongTimer?: NodeJS.Timeout;
    private lastActivityTime = 0;
    private lastPongTime = 0;
    private isClosing = false;
    private subscriptions = new Set<string>();
    private pendingSubscriptions = new Map<string, number>();
    private subscribeWaitMs: number;
    private connectionWaiters: Array<(error?: Error) => void> = [];

    constructor(options: WebSocketManagerOptions) {
        super();
        this.url = options.url;
        this.reconnectInterval = options.reconnectInterval ?? 5000;
        this.maxReconnectAttempts = options.maxReconnectAttempts ?? 10;
        this.pingInterval = options.pingInterval ?? 30000;
        this.pongTimeout = options.pongTimeout ?? 10000;
        this.pingMode = options.pingMode ?? PingMode.Application;
        // A subscribe that arrives while the socket is down waits this long for it to come
        // back. It has to stay well inside the router's own request deadline, so a caller
        // still gets an answer rather than being handed a timeout by something upstream.
        this.subscribeWaitMs = options.subscribeWaitMs ?? 10000;
    }

    connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                resolve();
                return;
            }

            this.ws = new WebSocket(this.url);

            this.ws.on('open', () => {
                this.reconnectAttempts = 0;
                this.resolveConnectionWaiters();
                this.recordActivity();
                this.startPing();
                this.emit('connected');
                this.resubscribePendingSubscriptions();
                // Ensure connection is fully established before resolving
                process.nextTick(() => resolve());
            });

            this.ws.on('message', (data: WebSocket.Data) => {
                const messageString = data.toString();

                // The events server implements keepalive at the application level:
                // it replies to a "ping" text frame with a "pong" text frame. This
                // is required because API Gateway WebSocket APIs do not surface
                // protocol-level ping/pong control frames to the Lambda backend, so
                // ws.ping()/the 'pong' event would never get a response. Treat the
                // "pong" text message as our liveness signal.
                if (messageString.trim() === 'pong') {
                    this.lastPongTime = Date.now();
                    this.recordActivity();
                    this.emit('pong');
                    return;
                }

                // Any inbound frame proves the connection is alive, so cancel any
                // pending pong-timeout even if we never see the pong itself.
                this.recordActivity();
                try {
                    const message = JSON.parse(messageString);
                    this.emit('message', message);
                } catch (error) {
                    const trimmed = messageString.trim();
                    // Log the full message content for debugging
                    logger.warn(
                        `WebSocket received non-JSON message: "${messageString}" (length: ${messageString.length})`,
                    );
                    // Only emit error if it looks like it should be JSON (starts with { or [ or contains JSON-like patterns)
                    if (
                        trimmed.startsWith('{') ||
                        trimmed.startsWith('[') ||
                        trimmed.includes('{') ||
                        trimmed.includes('[')
                    ) {
                        this.emit('error', new Error(`Failed to parse message: ${error}`));
                    }
                    // Otherwise, silently ignore non-JSON messages (might be ping/pong, control frames, etc.)
                }
            });

            this.ws.on('error', (error: Error) => {
                this.emit('error', error);
                reject(error);
            });

            this.ws.on('close', (code: number, reason: string) => {
                this.stopPing();
                this.emit('disconnected', {code, reason});

                if (!this.isClosing && this.reconnectAttempts < this.maxReconnectAttempts) {
                    this.reconnectAttempts++;
                    // Retry the first attempt at once. API Gateway closes every connection at
                    // two hours whatever its health, so the common case is a socket that will
                    // come straight back, and waiting the full interval before even trying is
                    // what turns that routine close into seconds of failed requests.
                    const delay = this.reconnectAttempts === 1 ? 0 : this.reconnectInterval;
                    setTimeout(() => {
                        this.connect().catch(error => {
                            logger.error('Reconnection failed:', error);
                        });
                    }, delay);
                } else if (!this.isClosing) {
                    this.resolveConnectionWaiters(
                        new Error(`WebSocket gave up after ${this.maxReconnectAttempts} reconnection attempts`),
                    );
                }
            });

            this.ws.on('pong', () => {
                // Only trusted as a liveness signal in 'control' mode. Behind API
                // Gateway a protocol pong is answered at the AWS edge, so in the
                // default 'application' mode we ignore it and rely on the "pong"
                // text message instead (handled above).
                if (this.pingMode === PingMode.Control) {
                    this.lastPongTime = Date.now();
                    this.recordActivity();
                    this.emit('pong');
                }
            });
        });
    }

    send(data: any): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                reject(new Error('WebSocket is not connected'));
                return;
            }

            const message = typeof data === 'string' ? data : JSON.stringify(data);

            this.ws.send(message, error => {
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
    }

    /**
     * Subscribe, waiting for the socket if it happens to be down.
     *
     * Rejecting outright on a closed socket means every request arriving during a reconnect
     * is answered with an immediate 500, which is a poor trade when the caller is willing to
     * wait a minute for its result anyway.
     */
    async subscribe(topic: string): Promise<void> {
        this.subscriptions.add(topic);
        this.pendingSubscriptions.set(topic, Date.now());
        try {
            await this.waitUntilConnected(this.subscribeWaitMs);
            await this.send(`subscribe: ${topic}`);
        } catch (error) {
            // Undo the bookkeeping: a later reconnect resubscribes whatever is still pending,
            // and this caller has already been given an error and is not listening any more.
            this.subscriptions.delete(topic);
            this.pendingSubscriptions.delete(topic);
            throw error;
        }
    }

    private waitUntilConnected(timeoutMs: number): Promise<void> {
        if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
        if (this.isClosing) return Promise.reject(new Error('WebSocket is closing'));
        return new Promise<void>((resolve, reject) => {
            const waiter = (error?: Error) => {
                clearTimeout(timer);
                if (error) reject(error);
                else resolve();
            };
            const timer = setTimeout(() => {
                this.connectionWaiters = this.connectionWaiters.filter(w => w !== waiter);
                reject(new Error(`WebSocket did not reconnect within ${timeoutMs}ms`));
            }, timeoutMs);
            // An explicit list rather than a 'connected' listener per caller: under load there
            // can be hundreds waiting at once, well past EventEmitter's listener warning.
            this.connectionWaiters.push(waiter);
        });
    }

    private resolveConnectionWaiters(error?: Error): void {
        const waiters = this.connectionWaiters;
        this.connectionWaiters = [];
        for (const waiter of waiters) waiter(error);
    }

    unsubscribe(topic: string): Promise<void> {
        this.subscriptions.delete(topic);
        this.pendingSubscriptions.delete(topic);
        return this.send(`unsubscribe: ${topic}`);
    }

    close(): void {
        this.isClosing = true;
        this.stopPing();
        this.resolveConnectionWaiters(new Error('WebSocket is closing'));
        this.subscriptions.clear();
        this.pendingSubscriptions.clear();

        if (this.ws) {
            this.ws.close(1000, 'Client closing connection');
            this.ws = null;
        }
    }

    private recordActivity(): void {
        this.lastActivityTime = Date.now();
        // Inbound traffic (pong or any message) means the peer is alive, so the
        // connection is not dead: cancel the pending termination.
        this.clearPongTimer();
    }

    private startPing(): void {
        this.stopPing();
        this.pingTimer = setInterval(() => this.sendHeartbeat(), this.pingInterval);
    }

    private sendHeartbeat(): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return;
        }

        // A pong timer is still pending from a previous heartbeat with no response
        // in between; don't stack another. The pending timer will terminate us.
        if (this.pongTimer) {
            return;
        }

        if (this.pingMode === PingMode.Control) {
            // Protocol-level ping. The 'pong' control-frame handler records the
            // response. Note this only proves reachability to the API Gateway
            // edge, not to the Lambda backend (see PingMode docs).
            this.ws.ping();
        } else {
            // Application-level ping: the events server replies with a "pong"
            // text message (see the message handler), which round-trips through
            // the Lambda backend for true end-to-end liveness.
            this.send('ping').catch(error => {
                logger.warn('Failed to send heartbeat ping:', error);
            });
        }

        // If neither a pong nor any other inbound frame arrives before the
        // deadline, the socket is silently dead (half-open TCP, dropped network,
        // LB reaping an idle connection). terminate() forces an immediate close
        // which triggers the normal reconnect path, instead of waiting minutes
        // for the OS TCP stack to notice.
        this.pongTimer = setTimeout(() => {
            this.pongTimer = undefined;
            const staleFor = this.lastActivityTime ? Date.now() - this.lastActivityTime : -1;
            logger.warn(
                `WebSocket heartbeat timed out: no pong/activity within ${this.pongTimeout}ms ` +
                    `(last activity ${staleFor}ms ago). Terminating dead connection.`,
            );
            this.emit('heartbeat-timeout');
            if (this.ws) {
                // terminate() (vs close()) skips the closing handshake, which a dead
                // peer would never answer; the 'close' handler drives reconnection.
                this.ws.terminate();
            }
        }, this.pongTimeout);
    }

    private clearPongTimer(): void {
        if (this.pongTimer) {
            clearTimeout(this.pongTimer);
            this.pongTimer = undefined;
        }
    }

    private stopPing(): void {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = undefined;
        }
        this.clearPongTimer();
    }

    isConnected(): boolean {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    }

    hasExhaustedReconnectAttempts(): boolean {
        return this.reconnectAttempts >= this.maxReconnectAttempts && !this.isConnected();
    }

    getReconnectAttempts(): number {
        return this.reconnectAttempts;
    }

    getMaxReconnectAttempts(): number {
        return this.maxReconnectAttempts;
    }

    getSubscriptions(): Set<string> {
        return new Set(this.subscriptions);
    }

    getLastActivityTime(): number {
        return this.lastActivityTime;
    }

    getLastPongTime(): number {
        return this.lastPongTime;
    }

    sendAck(guid: string): Promise<void> {
        return this.send(`ack: ${guid}`);
    }

    markSubscriptionReceived(guid: string): void {
        this.pendingSubscriptions.delete(guid);
    }

    private async resubscribePendingSubscriptions(): Promise<void> {
        const now = Date.now();
        const oneMinute = 60 * 1000;
        const toResubscribe: string[] = [];
        const toRemove: string[] = [];

        for (const [guid, timestamp] of this.pendingSubscriptions.entries()) {
            if (now - timestamp > oneMinute) {
                logger.info(`Removing expired pending subscription for GUID: ${guid}`);
                toRemove.push(guid);
            } else {
                toResubscribe.push(guid);
            }
        }

        toRemove.forEach(guid => this.pendingSubscriptions.delete(guid));

        if (toResubscribe.length > 0) {
            logger.info(`Resubscribing to ${toResubscribe.length} pending subscriptions after reconnection`);
            for (const guid of toResubscribe) {
                try {
                    await this.send(`subscribe: ${guid}`);
                    logger.debug(`Resubscribed to GUID: ${guid}`);
                } catch (error) {
                    logger.error(`Failed to resubscribe to GUID ${guid}:`, error);
                }
            }
        }
    }
}
