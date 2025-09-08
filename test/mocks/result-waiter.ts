import {CompilationResult} from '../../src/utils/index.js';

export class MockResultWaiter {
    private subscriptions = new Set<string>();
    private pendingResults = new Map<string, CompilationResult>();
    private shouldTimeout = false;
    private shouldFailSubscribe = false;

    async subscribe(guid: string): Promise<void> {
        if (this.shouldFailSubscribe) {
            throw new Error('Mock subscription failed');
        }
        this.subscriptions.add(guid);
        console.log(`Mock subscribed to: ${guid}`);
    }

    async unsubscribe(guid: string): Promise<void> {
        this.subscriptions.delete(guid);
        console.log(`Mock unsubscribed from: ${guid}`);
    }

    async waitForResult(guid: string, timeoutSeconds: number): Promise<CompilationResult> {
        if (this.shouldTimeout) {
            throw new Error(`No response received within ${timeoutSeconds} seconds for GUID: ${guid}`);
        }

        const result = this.pendingResults.get(guid);
        if (result) {
            this.pendingResults.delete(guid);
            return result;
        }

        // Return a default successful compilation result
        return {
            asm: [{text: 'mov eax, 42'}, {text: 'ret'}],
            code: 0,
            stdout: [{text: 'Compilation successful'}],
            stderr: [],
        };
    }

    // Test helper methods
    setResult(guid: string, result: CompilationResult): void {
        this.pendingResults.set(guid, result);
    }

    setShouldTimeout(shouldTimeout: boolean): void {
        this.shouldTimeout = shouldTimeout;
    }

    setShouldFailSubscribe(shouldFail: boolean): void {
        this.shouldFailSubscribe = shouldFail;
    }

    isSubscribed(guid: string): boolean {
        return this.subscriptions.has(guid);
    }

    reset(): void {
        this.subscriptions.clear();
        this.pendingResults.clear();
        this.shouldTimeout = false;
        this.shouldFailSubscribe = false;
    }
}
