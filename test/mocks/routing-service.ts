import {RoutingInfo} from '../../src/services/routing.js';

export interface SentSqsRequest {
    guid: string;
    compilerid: string;
    buildSystem: string | undefined;
    queueUrl: string;
}

export class MockRoutingService {
    // null marks a compiler the routing table does not know.
    private routingTable = new Map<string, RoutingInfo | null>();
    private sentRequests: SentSqsRequest[] = [];

    setRouting(compilerid: string, routingInfo: RoutingInfo | null): void {
        this.routingTable.set(compilerid, routingInfo);
    }

    async lookupCompilerRouting(compilerid: string): Promise<RoutingInfo | null> {
        const routing = this.routingTable.get(compilerid);
        if (routing !== undefined) {
            return routing;
        }

        // Default routing behavior
        return {
            type: 'queue',
            target: 'https://sqs.us-east-1.amazonaws.com/123456789/test-queue.fifo',
            environment: 'test',
        };
    }

    async sendToSqs(
        guid: string,
        compilerid: string,
        _body: string,
        buildSystem: string | undefined,
        _headers: Record<string, string | string[]>,
        _queryStringParameters: Record<string, string>,
        queueUrl: string,
    ): Promise<void> {
        // Mock implementation - just log the parameters
        console.log(`Mock SQS send: ${guid}, ${compilerid}, ${buildSystem ?? 'compile'}, ${queueUrl}`);

        this.sentRequests.push({guid, compilerid, buildSystem, queueUrl});

        // Simulate successful send
        if (queueUrl.includes('fail')) {
            throw new Error('Mock SQS send failed');
        }
    }

    getSentRequests(): SentSqsRequest[] {
        return this.sentRequests;
    }

    reset(): void {
        this.routingTable.clear();
        this.sentRequests = [];
    }
}
