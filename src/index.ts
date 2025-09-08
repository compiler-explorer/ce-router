import {WebSocketManager} from './services/websocket-manager.js';

const WEBSOCKET_URL = process.env.WEBSOCKET_URL || 'ws://localhost:8080';

async function main() {
    console.log('Starting CE Router Service...');

    const wsManager = new WebSocketManager({
        url: WEBSOCKET_URL,
        reconnectInterval: 5000,
        maxReconnectAttempts: 10,
        pingInterval: 30000,
    });

    wsManager.on('connected', () => {
        console.log('Connected to WebSocket server');
    });

    wsManager.on('disconnected', ({code, reason}) => {
        console.log(`Disconnected from WebSocket server: ${code} - ${reason}`);
    });

    wsManager.on('error', error => {
        console.error('WebSocket error:', error);
    });

    wsManager.on('message', message => {
        console.log('Received message:', message);
    });

    process.on('SIGTERM', () => {
        console.log('SIGTERM received, shutting down gracefully...');
        wsManager.close();
        process.exit(0);
    });

    process.on('SIGINT', () => {
        console.log('SIGINT received, shutting down gracefully...');
        wsManager.close();
        process.exit(0);
    });

    try {
        await wsManager.connect();
        console.log('CE Router Service started successfully');
    } catch (error) {
        console.error('Failed to start service:', error);
        process.exit(1);
    }
}

main().catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
});
