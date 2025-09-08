import {EventEmitter} from 'node:events';
import {vi} from 'vitest';

export class MockWebSocket extends EventEmitter {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    CONNECTING = 0;
    OPEN = 1;
    CLOSING = 2;
    CLOSED = 3;

    readyState: number = this.CONNECTING;
    url: string;

    send = vi.fn((data: string | Buffer, callback?: (error?: Error) => void) => {
        if (this.readyState !== this.OPEN) {
            const error = new Error('WebSocket is not open');
            if (callback) {
                callback(error);
                return;
            }
            throw error;
        }
        // Simulate successful send with async callback
        if (callback) {
            process.nextTick(() => callback());
        }
    });

    close = vi.fn((code?: number, reason?: string) => {
        this.readyState = this.CLOSING;
        setTimeout(() => {
            this.readyState = this.CLOSED;
            this.emit('close', code || 1000, reason || '');
        }, 0);
    });

    ping = vi.fn();
    pong = vi.fn();
    terminate = vi.fn();

    constructor(url: string, options?: any) {
        super();
        this.url = url;

        // Simulate connection opening immediately for tests
        this.readyState = this.OPEN;
        // Use nextTick to ensure event is emitted after listeners are attached
        process.nextTick(() => {
            this.emit('open');
        });
    }

    simulateMessage(data: string | Buffer) {
        this.emit('message', data);
    }

    simulateError(error: Error) {
        this.emit('error', error);
    }

    simulateClose(code = 1000, reason = '') {
        this.readyState = this.CLOSED;
        this.emit('close', code, reason);
    }
}

export const createMockWebSocketServer = () => {
    const server = new EventEmitter();
    const clients = new Set<MockWebSocket>();

    return {
        ...server,
        clients,
        handleUpgrade: vi.fn(),
        close: vi.fn(() => {
            clients.forEach(client => client.close());
            clients.clear();
        }),
    };
};
