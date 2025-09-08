import request from 'supertest';
import {beforeEach, describe, expect, it} from 'vitest';
import {TestableCompilerExplorerRouter} from '../mocks/testable-router.js';

describe('CompilerExplorerRouter', () => {
    let router: TestableCompilerExplorerRouter;
    let app: any;

    beforeEach(async () => {
        router = new TestableCompilerExplorerRouter({
            timeoutSeconds: 5,
        });
        app = router.getApp();
        await router.start();
    });

    describe('Health Check', () => {
        it('should return healthy status', async () => {
            const response = await request(app).get('/healthcheck');

            expect(response.status).toBe(200);
            expect(response.body).toMatchObject({
                status: 'healthy',
                websocket: 'connected',
            });
            expect(response.body.timestamp).toBeDefined();
        });
    });

    describe('CORS headers', () => {
        it('should include CORS headers in responses', async () => {
            const response = await request(app).get('/healthcheck');

            expect(response.headers['access-control-allow-origin']).toBe('*');
            expect(response.headers['access-control-allow-methods']).toBe('POST, GET, OPTIONS');
            expect(response.headers['access-control-allow-headers']).toBe('Content-Type, Accept, Authorization');
        });

        it('should handle OPTIONS requests', async () => {
            const response = await request(app).options('/api/compiler/g132/compile');

            expect(response.status).toBe(200);
        });
    });

    describe('Compilation endpoints', () => {
        describe('Queue-based routing (default)', () => {
            it('should handle compile request successfully', async () => {
                // Set up a successful compilation result
                const compilationResult = {
                    asm: [{text: 'mov eax, 42'}, {text: 'ret'}],
                    code: 0,
                    stdout: [{text: 'Compilation successful'}],
                    stderr: [],
                };

                // Mock the result for any GUID (since GUIDs are randomly generated)
                const originalWaitForResult = router.getMockResultWaiter().waitForResult;
                router.getMockResultWaiter().waitForResult = async () => compilationResult;

                const response = await request(app)
                    .post('/api/compiler/g132/compile')
                    .send({
                        source: 'int main() { return 42; }',
                        options: ['-O2'],
                    })
                    .expect(200);

                expect(response.body).toMatchObject({
                    asm: [{text: 'mov eax, 42'}, {text: 'ret'}],
                    code: 0,
                    stdout: [{text: 'Compilation successful'}],
                    stderr: [],
                });

                // Restore original method
                router.getMockResultWaiter().waitForResult = originalWaitForResult;
            });

            it('should handle cmake request successfully', async () => {
                const compilationResult = {
                    stdout: [{text: 'CMake successful'}],
                    code: 0,
                };

                const originalWaitForResult = router.getMockResultWaiter().waitForResult;
                router.getMockResultWaiter().waitForResult = async () => compilationResult;

                const response = await request(app)
                    .post('/api/compiler/g132/cmake')
                    .send({
                        source: 'cmake_minimum_required(VERSION 3.10)',
                        options: [],
                    })
                    .expect(200);

                expect(response.body).toMatchObject({
                    stdout: [{text: 'CMake successful'}],
                    code: 0,
                });

                router.getMockResultWaiter().waitForResult = originalWaitForResult;
            });

            it('should handle compilation timeout', async () => {
                router.setShouldTimeout(true);

                const response = await request(app)
                    .post('/api/compiler/g132/compile')
                    .send({
                        source: 'int main() { return 0; }',
                    })
                    .expect(408);

                expect(response.body).toMatchObject({
                    error: expect.stringContaining('Compilation timeout'),
                });
            });

            it('should handle subscription failure', async () => {
                router.setShouldFailSubscribe(true);

                const response = await request(app)
                    .post('/api/compiler/g132/compile')
                    .send({
                        source: 'int main() { return 0; }',
                    })
                    .expect(500);

                expect(response.body).toMatchObject({
                    error: expect.stringContaining('Failed to setup result subscription'),
                });
            });
        });

        describe('URL-based routing', () => {
            it('should handle URL forwarding', async () => {
                // Set up URL routing for a specific compiler
                router.setRouting('url-compiler', {
                    type: 'url',
                    target: 'http://example.com',
                    environment: 'test',
                });

                // Note: This test would require mocking the HTTP forwarder
                // For now, we'll just test that it attempts the URL routing path
                const response = await request(app).post('/api/compiler/url-compiler/compile').send({
                    source: 'int main() { return 0; }',
                });

                // The request will likely fail due to network issues, but we can verify
                // it's taking the URL routing path by checking it's not a queue-related error
                expect(response.status).not.toBe(200);
            });
        });

        describe('Content-Type handling', () => {
            it('should handle JSON content', async () => {
                const compilationResult = {code: 0, asm: []};
                const originalWaitForResult = router.getMockResultWaiter().waitForResult;
                router.getMockResultWaiter().waitForResult = async () => compilationResult;

                const response = await request(app)
                    .post('/api/compiler/g132/compile')
                    .set('Content-Type', 'application/json')
                    .send({
                        source: 'int main() { return 0; }',
                        options: ['-O2'],
                    })
                    .expect(200);

                expect(response.body).toMatchObject(compilationResult);
                router.getMockResultWaiter().waitForResult = originalWaitForResult;
            });

            it('should handle plain text content', async () => {
                const compilationResult = {code: 0, asm: []};
                const originalWaitForResult = router.getMockResultWaiter().waitForResult;
                router.getMockResultWaiter().waitForResult = async () => compilationResult;

                const response = await request(app)
                    .post('/api/compiler/g132/compile')
                    .set('Content-Type', 'text/plain')
                    .send('int main() { return 0; }')
                    .expect(200);

                expect(response.body).toMatchObject(compilationResult);
                router.getMockResultWaiter().waitForResult = originalWaitForResult;
            });
        });
    });

    describe('Response formatting', () => {
        it('should return JSON by default', async () => {
            const compilationResult = {
                asm: [{text: 'mov eax, 42'}, {text: 'ret'}],
                code: 0,
            };

            const originalWaitForResult = router.getMockResultWaiter().waitForResult;
            router.getMockResultWaiter().waitForResult = async () => compilationResult;

            const response = await request(app)
                .post('/api/compiler/g132/compile')
                .send({source: 'int main() { return 42; }'})
                .expect(200);

            expect(response.headers['content-type']).toContain('application/json');
            expect(response.body).toMatchObject(compilationResult);

            router.getMockResultWaiter().waitForResult = originalWaitForResult;
        });

        it('should return plain text when Accept header specifies text/plain', async () => {
            const compilationResult = {
                asm: [{text: 'mov eax, 42'}, {text: 'ret'}],
                code: 0,
            };

            const originalWaitForResult = router.getMockResultWaiter().waitForResult;
            router.getMockResultWaiter().waitForResult = async () => compilationResult;

            const response = await request(app)
                .post('/api/compiler/g132/compile')
                .set('Accept', 'text/plain')
                .send({source: 'int main() { return 42; }'})
                .expect(200);

            expect(response.headers['content-type']).toContain('text/plain');
            expect(typeof response.text).toBe('string');
            expect(response.text).toContain('mov eax, 42');

            router.getMockResultWaiter().waitForResult = originalWaitForResult;
        });
    });
});
