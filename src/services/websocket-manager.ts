import {EventEmitter} from 'node:events';
import WebSocket from 'ws';
import {logger} from '../lib/logger.js';

export interface WebSocketManagerOptions {
    url: string;
    reconnectInterval?: number;
    maxReconnectAttempts?: number;
    pingInterval?: number;
}

export class WebSocketManager extends EventEmitter {
    private ws: WebSocket | null = null;
    private url: string;
    private reconnectInterval: number;
    private maxReconnectAttempts: number;
    private pingInterval: number;
    private reconnectAttempts = 0;
    private pingTimer?: NodeJS.Timeout;
    private isClosing = false;
    private subscriptions = new Set<string>();

    constructor(options: WebSocketManagerOptions) {
        super();
        this.url = options.url;
        this.reconnectInterval = options.reconnectInterval || 5000;
        this.maxReconnectAttempts = options.maxReconnectAttempts || 10;
        this.pingInterval = options.pingInterval || 30000;
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
                this.startPing();
                this.emit('connected');
                // Ensure connection is fully established before resolving
                process.nextTick(() => resolve());
            });

            this.ws.on('message', (data: WebSocket.Data) => {
                const messageString = data.toString();
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
                    setTimeout(() => {
                        this.connect().catch(error => {
                            logger.error('Reconnection failed:', error);
                        });
                    }, this.reconnectInterval);
                }
            });

            this.ws.on('pong', () => {
                this.emit('pong');
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

    subscribe(topic: string): Promise<void> {
        this.subscriptions.add(topic);
        return this.send(`subscribe: ${topic}`);
    }

    unsubscribe(topic: string): Promise<void> {
        this.subscriptions.delete(topic);
        return this.send(`unsubscribe: ${topic}`);
    }

    close(): void {
        this.isClosing = true;
        this.stopPing();
        this.subscriptions.clear();

        if (this.ws) {
            this.ws.close(1000, 'Client closing connection');
            this.ws = null;
        }
    }

    private startPing(): void {
        this.stopPing();
        this.pingTimer = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.ping();
            }
        }, this.pingInterval);
    }

    private stopPing(): void {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = undefined;
        }
    }

    isConnected(): boolean {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    }

    getSubscriptions(): Set<string> {
        return new Set(this.subscriptions);
    }
}
