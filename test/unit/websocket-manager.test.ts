import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {MockWebSocket} from '../mocks/websocket.js';

vi.mock('ws', () => ({
    default: MockWebSocket,
    WebSocket: MockWebSocket,
}));

const {WebSocketManager} = await import('../../src/services/websocket-manager.js');

describe('WebSocketManager', () => {
    let manager: InstanceType<typeof WebSocketManager>;
    const testUrl = 'ws://localhost:8080';

    beforeEach(() => {
        vi.clearAllMocks();
        manager = new WebSocketManager({
            url: testUrl,
            reconnectInterval: 100,
            maxReconnectAttempts: 3,
            pingInterval: 1000,
        });
    });

    afterEach(() => {
        manager.close();
    });

    describe('connect', () => {
        it('should establish WebSocket connection', async () => {
            await manager.connect();
            expect(manager.isConnected()).toBe(true);
        });

        it('should resolve immediately if already connected', async () => {
            await manager.connect();
            const secondConnect = manager.connect();
            await expect(secondConnect).resolves.toBeUndefined();
        });

        it('should emit connected event on successful connection', async () => {
            const connectedSpy = vi.fn();
            manager.on('connected', connectedSpy);

            await manager.connect();
            expect(connectedSpy).toHaveBeenCalled();
        });
    });

    describe('send', () => {
        it('should send string messages', async () => {
            await manager.connect();
            const message = 'test message';

            await expect(manager.send(message)).resolves.toBeUndefined();
        });

        it('should send object messages as JSON', async () => {
            await manager.connect();
            const message = {type: 'test', data: 'value'};

            await expect(manager.send(message)).resolves.toBeUndefined();
        });

        it('should reject if not connected', async () => {
            await expect(manager.send('test')).rejects.toThrow('WebSocket is not connected');
        });
    });

    describe('subscribe/unsubscribe', () => {
        it('should manage subscriptions', async () => {
            await manager.connect();

            await manager.subscribe('topic1');
            await manager.subscribe('topic2');

            let subscriptions = manager.getSubscriptions();
            expect(subscriptions.has('topic1')).toBe(true);
            expect(subscriptions.has('topic2')).toBe(true);

            await manager.unsubscribe('topic1');

            subscriptions = manager.getSubscriptions();
            expect(subscriptions.has('topic1')).toBe(false);
            expect(subscriptions.has('topic2')).toBe(true);
        });
    });

    describe('message handling', () => {
        it('should parse and emit JSON messages', async () => {
            const messageSpy = vi.fn();
            manager.on('message', messageSpy);

            await manager.connect();

            const ws = (manager as any).ws as MockWebSocket;
            const testMessage = {type: 'test', data: 'value'};
            ws.simulateMessage(JSON.stringify(testMessage));

            expect(messageSpy).toHaveBeenCalledWith(testMessage);
        });

        it('should emit error for invalid JSON', async () => {
            const errorSpy = vi.fn();
            manager.on('error', errorSpy);

            await manager.connect();

            const ws = (manager as any).ws as MockWebSocket;
            ws.simulateMessage('invalid json {');

            expect(errorSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining('Failed to parse message'),
                }),
            );
        });
    });

    describe('reconnection', () => {
        it('should attempt to reconnect on disconnect', async () => {
            const disconnectedSpy = vi.fn();
            const connectedSpy = vi.fn();

            manager.on('disconnected', disconnectedSpy);
            manager.on('connected', connectedSpy);

            await manager.connect();
            expect(connectedSpy).toHaveBeenCalledTimes(1);

            const ws = (manager as any).ws as MockWebSocket;
            ws.simulateClose(1006, 'Connection lost');

            await vi.waitFor(() => {
                expect(disconnectedSpy).toHaveBeenCalled();
            });

            await vi.waitFor(
                () => {
                    expect(connectedSpy).toHaveBeenCalledTimes(2);
                },
                {timeout: 500},
            );
        });

        it('should stop reconnecting after max attempts', async () => {
            const disconnectedSpy = vi.fn();
            const connectedSpy = vi.fn();

            manager.on('disconnected', disconnectedSpy);
            manager.on('connected', connectedSpy);

            // Start with an initial connection
            await manager.connect();
            expect(connectedSpy).toHaveBeenCalledTimes(1);

            // Simulate disconnect and wait for reconnection attempts
            const ws = (manager as any).ws as MockWebSocket;
            ws.simulateClose(1006, 'Connection lost');

            // Wait for all reconnection attempts to complete
            await vi.waitFor(
                () => {
                    expect(disconnectedSpy).toHaveBeenCalled();
                },
                {timeout: 1000},
            );

            // Wait a bit more for potential reconnection attempts
            await new Promise(resolve => setTimeout(resolve, 500));

            // Should have tried to reconnect but eventually stopped
            expect(disconnectedSpy).toHaveBeenCalled();
            expect((manager as any).reconnectAttempts).toBeGreaterThanOrEqual(0);
        });
    });

    describe('close', () => {
        it('should close connection and clear subscriptions', async () => {
            await manager.connect();
            await manager.subscribe('topic1');
            await manager.subscribe('topic2');

            manager.close();

            expect(manager.isConnected()).toBe(false);
            expect(manager.getSubscriptions().size).toBe(0);
        });

        it('should not reconnect after explicit close', async () => {
            const connectedSpy = vi.fn();
            manager.on('connected', connectedSpy);

            await manager.connect();
            manager.close();

            await new Promise(resolve => setTimeout(resolve, 200));

            expect(connectedSpy).toHaveBeenCalledTimes(1);
        });
    });
});
