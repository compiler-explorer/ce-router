import {CompilerExplorerRouter, CompilerExplorerRouterConfig} from '../../src/compiler-explorer-router.js';
import {RoutingInfo} from '../../src/services/routing.js';
import {WebSocketManager} from '../../src/services/websocket-manager.js';
import {MockResultWaiter} from './result-waiter.js';
import {MockRoutingService} from './routing-service.js';

export class TestableCompilerExplorerRouter extends CompilerExplorerRouter {
    private mockRoutingService: MockRoutingService;
    private mockResultWaiter: MockResultWaiter;

    constructor(config: CompilerExplorerRouterConfig = {}, mockWebSocketManager?: WebSocketManager) {
        // Create mock services
        const mockWsManager = mockWebSocketManager || new MockWebSocketManager();
        const mockResultWaiter = new MockResultWaiter();

        // Pass mocks to parent constructor
        super(config, mockWsManager, mockResultWaiter as any);

        this.mockRoutingService = new MockRoutingService();
        this.mockResultWaiter = mockResultWaiter;
    }

    // Override the routing lookup method to use our mock
    protected async getRoutingInfo(compilerid: string): Promise<RoutingInfo> {
        return this.mockRoutingService.lookupCompilerRouting(compilerid);
    }

    // Override the SQS sending to use our mock
    protected async sendToQueue(
        guid: string,
        compilerid: string,
        body: string,
        isCmake: boolean,
        headers: Record<string, string | string[]>,
        queryStringParameters: Record<string, string>,
        queueUrl: string,
    ): Promise<void> {
        return this.mockRoutingService.sendToSqs(
            guid,
            compilerid,
            body,
            isCmake,
            headers,
            queryStringParameters,
            queueUrl,
        );
    }

    // Test helper methods
    public setRouting(compilerid: string, routingInfo: RoutingInfo): void {
        this.mockRoutingService.setRouting(compilerid, routingInfo);
    }

    public setCompilationResult(guid: string, result: any): void {
        this.mockResultWaiter.setResult(guid, result);
    }

    public setShouldTimeout(shouldTimeout: boolean): void {
        this.mockResultWaiter.setShouldTimeout(shouldTimeout);
    }

    public setShouldFailSubscribe(shouldFail: boolean): void {
        this.mockResultWaiter.setShouldFailSubscribe(shouldFail);
    }

    public isSubscribed(guid: string): boolean {
        return this.mockResultWaiter.isSubscribed(guid);
    }

    public resetMocks(): void {
        this.mockRoutingService.reset();
        this.mockResultWaiter.reset();
    }

    public getMockResultWaiter(): MockResultWaiter {
        return this.mockResultWaiter;
    }

    public getMockRoutingService(): MockRoutingService {
        return this.mockRoutingService;
    }
}

// Mock WebSocket Manager for testing
class MockWebSocketManager extends WebSocketManager {
    private mockConnected = false;
    private mockSubscriptions = new Set<string>();

    constructor() {
        super({url: 'ws://localhost:8080/test'});
    }

    async connect(): Promise<void> {
        this.mockConnected = true;
        this.emit('connected');
    }

    close(): void {
        this.mockConnected = false;
        this.mockSubscriptions.clear();
        this.emit('disconnected', {code: 1000, reason: 'Normal closure'});
    }

    async send(data: any): Promise<void> {
        // Mock implementation
        console.log('Mock WebSocket send:', data);
    }

    async subscribe(topic: string): Promise<void> {
        this.mockSubscriptions.add(topic);
        console.log(`Mock WebSocket subscribed to: ${topic}`);
    }

    async unsubscribe(topic: string): Promise<void> {
        this.mockSubscriptions.delete(topic);
        console.log(`Mock WebSocket unsubscribed from: ${topic}`);
    }

    isConnected(): boolean {
        return this.mockConnected;
    }

    getSubscriptions(): Set<string> {
        return new Set(this.mockSubscriptions);
    }

    // Test helper to simulate receiving a message
    simulateMessage(message: any): void {
        this.emit('message', message);
    }
}
