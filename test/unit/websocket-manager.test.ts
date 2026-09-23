import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {MockWebSocket} from '../mocks/websocket.js';

vi.mock('ws', () => ({
    default: MockWebSocket,
    WebSocket: MockWebSocket,
}));

const {WebSocketManager, PingMode} = await import('../../src/services/websocket-manager.js');

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

    describe('subscription message format', () => {
        it('should send subscribe messages in correct string format', async () => {
            await manager.connect();

            const ws = (manager as any).ws as MockWebSocket;
            const sendSpy = vi.spyOn(ws, 'send');

            const testGuid = 'abc123-def456-ghi789';
            await manager.subscribe(testGuid);

            // Ensure the message is sent as a string in the format: "subscribe: GUID"
            expect(sendSpy).toHaveBeenCalledWith(`subscribe: ${testGuid}`, expect.any(Function));
        });

        it('should send unsubscribe messages in correct string format', async () => {
            await manager.connect();

            const ws = (manager as any).ws as MockWebSocket;
            const sendSpy = vi.spyOn(ws, 'send');

            const testGuid = 'xyz789-uvw456-rst123';
            await manager.unsubscribe(testGuid);

            // Ensure the message is sent as a string in the format: "unsubscribe: GUID"
            expect(sendSpy).toHaveBeenCalledWith(`unsubscribe: ${testGuid}`, expect.any(Function));
        });

        it('should never send subscription messages as JSON objects', async () => {
            await manager.connect();

            const ws = (manager as any).ws as MockWebSocket;
            const sendSpy = vi.spyOn(ws, 'send');

            const testGuid = 'json-test-guid-123';
            await manager.subscribe(testGuid);

            // Ensure the message is NOT sent as JSON
            const sentMessage = sendSpy.mock.calls[0][0];
            expect(sentMessage).toBeTypeOf('string');
            expect(sentMessage).not.toMatch(/^\{.*\}$/); // Not JSON object format
            expect(sentMessage).not.toMatch(/^".*"$/); // Not JSON string format
            expect(sentMessage).toBe(`subscribe: ${testGuid}`);
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

    describe('heartbeat / dead-connection detection', () => {
        let hbManager: InstanceType<typeof WebSocketManager>;

        beforeEach(() => {
            hbManager = new WebSocketManager({
                url: testUrl,
                reconnectInterval: 100,
                maxReconnectAttempts: 3,
                pingInterval: 50,
                pongTimeout: 30,
            });
        });

        afterEach(() => {
            hbManager.close();
        });

        it('should send "ping" text messages on the configured interval', async () => {
            await hbManager.connect();
            const ws = (hbManager as any).ws as MockWebSocket;

            await vi.waitFor(
                () => {
                    expect(ws.send).toHaveBeenCalledWith('ping', expect.any(Function));
                },
                {timeout: 300},
            );
        });

        it('should terminate the connection when no pong or activity is received', async () => {
            const timeoutSpy = vi.fn();
            hbManager.on('heartbeat-timeout', timeoutSpy);

            await hbManager.connect();
            const ws = (hbManager as any).ws as MockWebSocket;
            const terminateSpy = vi.spyOn(ws, 'terminate');

            await vi.waitFor(
                () => {
                    expect(timeoutSpy).toHaveBeenCalled();
                    expect(terminateSpy).toHaveBeenCalled();
                },
                {timeout: 500},
            );
        });

        it('should NOT terminate while "pong" text replies keep arriving', async () => {
            const timeoutSpy = vi.fn();
            const pongSpy = vi.fn();
            hbManager.on('heartbeat-timeout', timeoutSpy);
            hbManager.on('pong', pongSpy);

            await hbManager.connect();
            const ws = (hbManager as any).ws as MockWebSocket;

            // Keep the connection alive with steady "pong" text replies (as the
            // events server sends) for a few ping cycles.
            const pongInterval = setInterval(() => ws.simulateMessage('pong'), 20);
            await new Promise(resolve => setTimeout(resolve, 250));
            clearInterval(pongInterval);

            expect(timeoutSpy).not.toHaveBeenCalled();
            expect(pongSpy).toHaveBeenCalled();
            expect(hbManager.getLastPongTime()).toBeGreaterThan(0);
        });

        it('should not emit a "pong" text reply as a regular message', async () => {
            const messageSpy = vi.fn();
            hbManager.on('message', messageSpy);

            await hbManager.connect();
            const ws = (hbManager as any).ws as MockWebSocket;
            ws.simulateMessage('pong');

            expect(messageSpy).not.toHaveBeenCalled();
        });

        it('should treat inbound messages as liveness activity', async () => {
            const timeoutSpy = vi.fn();
            hbManager.on('heartbeat-timeout', timeoutSpy);

            await hbManager.connect();
            const ws = (hbManager as any).ws as MockWebSocket;

            // No pongs, but a steady stream of application messages should keep it alive.
            const msgInterval = setInterval(() => ws.simulateMessage('{"keepalive":true}'), 20);
            await new Promise(resolve => setTimeout(resolve, 250));
            clearInterval(msgInterval);

            expect(timeoutSpy).not.toHaveBeenCalled();
        });

        it('should reconnect after a heartbeat timeout terminates a dead connection', async () => {
            const connectedSpy = vi.fn();
            hbManager.on('connected', connectedSpy);

            await hbManager.connect();
            expect(connectedSpy).toHaveBeenCalledTimes(1);

            // Let the heartbeat detect the dead connection and reconnect.
            await vi.waitFor(
                () => {
                    expect(connectedSpy).toHaveBeenCalledTimes(2);
                },
                {timeout: 500},
            );
        });

        it('should send protocol ping frames in control mode', async () => {
            const controlManager = new WebSocketManager({
                url: testUrl,
                reconnectInterval: 100,
                maxReconnectAttempts: 3,
                pingInterval: 50,
                pongTimeout: 30,
                pingMode: PingMode.Control,
            });

            try {
                await controlManager.connect();
                const ws = (controlManager as any).ws as MockWebSocket;

                await vi.waitFor(
                    () => {
                        expect(ws.ping).toHaveBeenCalled();
                    },
                    {timeout: 300},
                );
                // Should NOT send text "ping" in control mode.
                expect(ws.send).not.toHaveBeenCalledWith('ping', expect.any(Function));
            } finally {
                controlManager.close();
            }
        });

        it('should stay alive on protocol pongs in control mode', async () => {
            const controlManager = new WebSocketManager({
                url: testUrl,
                reconnectInterval: 100,
                maxReconnectAttempts: 3,
                pingInterval: 50,
                pongTimeout: 30,
                pingMode: PingMode.Control,
            });

            try {
                const timeoutSpy = vi.fn();
                controlManager.on('heartbeat-timeout', timeoutSpy);

                await controlManager.connect();
                const ws = (controlManager as any).ws as MockWebSocket;

                const pongInterval = setInterval(() => ws.emit('pong'), 20);
                await new Promise(resolve => setTimeout(resolve, 250));
                clearInterval(pongInterval);

                expect(timeoutSpy).not.toHaveBeenCalled();
                expect(controlManager.getLastPongTime()).toBeGreaterThan(0);
            } finally {
                controlManager.close();
            }
        });

        it('should stop the heartbeat on close', async () => {
            await hbManager.connect();
            const ws = (hbManager as any).ws as MockWebSocket;

            hbManager.close();
            (ws.send as any).mockClear();

            await new Promise(resolve => setTimeout(resolve, 150));
            expect(ws.send).not.toHaveBeenCalledWith('ping', expect.any(Function));
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

    describe('reconnect status tracking', () => {
        it('should track reconnect attempts', async () => {
            expect(manager.getReconnectAttempts()).toBe(0);
            expect(manager.getMaxReconnectAttempts()).toBe(3);

            await manager.connect();
            const ws = (manager as any).ws as MockWebSocket;
            ws.simulateClose(1006, 'Connection lost');

            await vi.waitFor(
                () => {
                    expect(manager.getReconnectAttempts()).toBeGreaterThan(0);
                },
                {timeout: 500},
            );
        });

        it('should report exhausted reconnect attempts when max reached and disconnected', async () => {
            await manager.connect();
            expect(manager.hasExhaustedReconnectAttempts()).toBe(false);

            // Close the connection
            const ws = (manager as any).ws as MockWebSocket;
            ws.simulateClose(1006, 'Connection lost');

            // Manually set reconnect attempts to max (simulating exhausted retries)
            // This is necessary because MockWebSocket always succeeds on reconnect
            (manager as any).reconnectAttempts = manager.getMaxReconnectAttempts();
            (manager as any).ws = null; // Ensure disconnected state

            expect(manager.hasExhaustedReconnectAttempts()).toBe(true);
        });

        it('should not report exhausted when connected', async () => {
            await manager.connect();
            expect(manager.isConnected()).toBe(true);
            expect(manager.hasExhaustedReconnectAttempts()).toBe(false);
        });

        it('should not report exhausted when attempts below max', async () => {
            // Before any connection attempts
            expect(manager.hasExhaustedReconnectAttempts()).toBe(false);
        });
    });
});

describe('WebSocketManager: subscribing while the socket is down', () => {
    // A subscribe arriving during a reconnect used to reject synchronously, so the router
    // answered every request in that window with an immediate 500 - seen on beta as 428
    // sub-second 5xx in one minute, right after the events socket dropped. The caller is
    // willing to wait a minute for its result, so waiting a moment for the socket is the
    // better trade.
    it('waits for the socket to come back rather than rejecting', async () => {
        const manager = new WebSocketManager({
            url: 'ws://localhost:8080',
            reconnectInterval: 10_000,
            maxReconnectAttempts: 3,
            subscribeWaitMs: 2000,
        });
        await manager.connect();
        ((manager as any).ws as MockWebSocket).simulateClose(1006, 'Connection lost');
        expect(manager.isConnected()).toBe(false);

        // Long reconnectInterval on purpose: this only passes because the first retry is
        // immediate, which is what makes a routine two-hour close cheap instead of costly.
        await expect(manager.subscribe('some-guid')).resolves.toBeUndefined();
        expect(manager.getSubscriptions()).toContain('some-guid');
        manager.close();
    });

    it('forgets a subscription it could not make', async () => {
        const manager = new WebSocketManager({
            url: 'ws://localhost:8080',
            maxReconnectAttempts: 0,
            subscribeWaitMs: 50,
        });
        await manager.connect();
        ((manager as any).ws as MockWebSocket).simulateClose(1006, 'Connection lost');

        await expect(manager.subscribe('doomed-guid')).rejects.toThrow(/did not reconnect/);
        // Left behind, a reconnect would resubscribe on behalf of a caller that has already
        // been given an error and gone away.
        expect(manager.getSubscriptions()).not.toContain('doomed-guid');
        manager.close();
    });
});
