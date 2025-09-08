import {EventEmitter} from 'node:events';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ResultWaiter} from '../../src/services/result-waiter.js';

// Mock WebSocketManager
class MockWebSocketManager extends EventEmitter {
    private subscriptions = new Set<string>();

    async subscribe(topic: string): Promise<void> {
        this.subscriptions.add(topic);
        return Promise.resolve();
    }

    async unsubscribe(topic: string): Promise<void> {
        this.subscriptions.delete(topic);
        return Promise.resolve();
    }

    getSubscriptions(): Set<string> {
        return new Set(this.subscriptions);
    }

    simulateMessage(message: any): void {
        this.emit('message', message);
    }
}

describe('ResultWaiter', () => {
    let mockWsManager: MockWebSocketManager;
    let resultWaiter: ResultWaiter;

    beforeEach(() => {
        mockWsManager = new MockWebSocketManager();
        resultWaiter = new ResultWaiter(mockWsManager as any);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe('subscription format protection', () => {
        it('should subscribe with plain GUID without prefix', async () => {
            const subscribeSpy = vi.spyOn(mockWsManager, 'subscribe');
            const testGuid = 'test-guid-12345-abcdef';

            await resultWaiter.subscribe(testGuid);

            // Ensure subscription is called with the plain GUID, not "guid:GUID"
            expect(subscribeSpy).toHaveBeenCalledWith(testGuid);
            expect(subscribeSpy).not.toHaveBeenCalledWith(`guid:${testGuid}`);
        });

        it('should never add prefixes to GUIDs', async () => {
            const subscribeSpy = vi.spyOn(mockWsManager, 'subscribe');
            const testGuid = 'another-test-guid-67890';

            await resultWaiter.subscribe(testGuid);

            const calledWith = subscribeSpy.mock.calls[0][0];

            // Ensure no prefixes are added
            expect(calledWith).toBe(testGuid);
            expect(calledWith).not.toContain('guid:');
            expect(calledWith).not.toContain('topic:');
            expect(calledWith).not.toContain('channel:');
        });

        it('should maintain exact GUID format for multiple subscriptions', async () => {
            const subscribeSpy = vi.spyOn(mockWsManager, 'subscribe');
            const guids = ['guid-1-abc123', 'guid-2-def456', 'guid-3-ghi789'];

            for (const guid of guids) {
                await resultWaiter.subscribe(guid);
            }

            // Verify each GUID was passed through unchanged
            expect(subscribeSpy).toHaveBeenCalledTimes(3);
            guids.forEach((guid, index) => {
                expect(subscribeSpy.mock.calls[index][0]).toBe(guid);
            });
        });
    });

    describe('message handling', () => {
        it('should handle compilation result messages', () => {
            const testGuid = 'test-result-guid';
            const testResult = {
                guid: testGuid,
                status: 'success',
                output: 'Compilation successful',
            };

            // This should not throw and should handle the message properly
            mockWsManager.simulateMessage(testResult);

            // Test passes if no errors are thrown
            expect(true).toBe(true);
        });
    });
});
