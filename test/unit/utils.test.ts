import {describe, expect, it} from 'vitest';
import {
    buildSystemFromPath,
    createErrorResponse,
    createSuccessResponse,
    extractCompilerId,
    generateGuid,
    parseRequestBody,
} from '../../src/utils/index.js';

describe('Utility functions', () => {
    describe('generateGuid', () => {
        it('should generate a unique GUID', () => {
            const guid1 = generateGuid();
            const guid2 = generateGuid();

            expect(guid1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
            expect(guid2).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
            expect(guid1).not.toBe(guid2);
        });
    });

    describe('extractCompilerId', () => {
        it('should extract compiler ID from production format path', () => {
            const path = '/api/compiler/g132/compile';
            const compilerId = extractCompilerId(path);

            expect(compilerId).toBe('g132');
        });

        it('should extract compiler ID from environment format path', () => {
            const path = '/prod/api/compiler/clang15/compile';
            const compilerId = extractCompilerId(path);

            expect(compilerId).toBe('clang15');
        });

        it('should extract compiler ID from cmake path', () => {
            const path = '/api/compiler/g132/cmake';
            const compilerId = extractCompilerId(path);

            expect(compilerId).toBe('g132');
        });

        it('should handle paths with leading/trailing slashes', () => {
            const path = '///api/compiler/g132/compile///';
            const compilerId = extractCompilerId(path);

            expect(compilerId).toBe('g132');
        });

        it('should return null for invalid paths', () => {
            expect(extractCompilerId('/invalid/path')).toBeNull();
            expect(extractCompilerId('/api/wrong/format')).toBeNull();
            expect(extractCompilerId('')).toBeNull();
        });
    });

    describe('buildSystemFromPath', () => {
        it('should name the build system a build path asks for', () => {
            expect(buildSystemFromPath('/api/compiler/g132/build/cmake')).toBe('cmake');
            expect(buildSystemFromPath('/api/compiler/g132/build/cargo')).toBe('cargo');
            expect(buildSystemFromPath('/beta/api/compiler/g132/build/maven')).toBe('maven');
        });

        it('should read the original cmake spelling as cmake', () => {
            expect(buildSystemFromPath('/api/compiler/g132/cmake')).toBe('cmake');
            expect(buildSystemFromPath('/prod/api/compiler/g132/cmake')).toBe('cmake');
        });

        it('should return null for compile paths', () => {
            expect(buildSystemFromPath('/api/compiler/g132/compile')).toBeNull();
            expect(buildSystemFromPath('/prod/api/compiler/g132/compile')).toBeNull();
        });

        it('should return null when no build system is named', () => {
            expect(buildSystemFromPath('/api/compiler/g132/build')).toBeNull();
            expect(buildSystemFromPath('/api/compiler/g132/build/')).toBeNull();
            expect(buildSystemFromPath('/api/compiler/g132')).toBeNull();
            expect(buildSystemFromPath('/invalid/path')).toBeNull();
        });
    });

    describe('parseRequestBody', () => {
        it('should parse JSON content type', () => {
            const body = '{"source": "int main(){}", "options": ["-O2"]}';
            const contentType = 'application/json';
            const parsed = parseRequestBody(body, contentType);

            expect(parsed).toEqual({
                source: 'int main(){}',
                options: ['-O2'],
            });
        });

        it('should treat plain text as source code', () => {
            const body = 'int main() { return 0; }';
            const contentType = 'text/plain';
            const parsed = parseRequestBody(body, contentType);

            expect(parsed).toEqual({
                source: 'int main() { return 0; }',
            });
        });

        it('should treat invalid JSON as source code', () => {
            const body = 'int main() { invalid json }';
            const contentType = 'application/json';
            const parsed = parseRequestBody(body, contentType);

            expect(parsed).toEqual({
                source: 'int main() { invalid json }',
            });
        });

        it('should handle empty body', () => {
            const parsed = parseRequestBody('', 'application/json');

            expect(parsed).toEqual({});
        });

        it('should handle missing content type', () => {
            const body = 'int main() { return 0; }';
            const parsed = parseRequestBody(body);

            expect(parsed).toEqual({
                source: 'int main() { return 0; }',
            });
        });
    });

    describe('createErrorResponse', () => {
        it('should create a proper error response', () => {
            const response = createErrorResponse(500, 'Test error message');

            expect(response.statusCode).toBe(500);
            expect(response.headers['Content-Type']).toBe('application/json');
            expect(response.headers['Access-Control-Allow-Origin']).toBe('*');
            expect(JSON.parse(response.body)).toEqual({
                error: 'Test error message',
            });
        });
    });

    describe('createSuccessResponse', () => {
        const mockResult = {
            guid: 'test-guid',
            s3Key: 'test-s3-key',
            asm: [{text: 'mov eax, 42'}, {text: 'ret'}],
            code: 0,
            stdout: [{text: 'Compilation successful'}],
            stderr: [],
        };

        it('should create JSON response by default', () => {
            const result = {...mockResult};
            const response = createSuccessResponse(result, false, true);

            expect(response.statusCode).toBe(200);
            expect(response.headers['Content-Type']).toBe('application/json; charset=utf-8');
            expect(response.headers['Access-Control-Allow-Origin']).toBe('*');

            const responseBody = JSON.parse(response.body);
            expect(responseBody.guid).toBeUndefined(); // Should be cleaned up
            expect(responseBody.s3Key).toBeUndefined(); // Should be cleaned up
            expect(responseBody.asm).toEqual([{text: 'mov eax, 42'}, {text: 'ret'}]);
            expect(responseBody.code).toBe(0);
        });

        it('defaults to plain text, matching the endpoint served directly', () => {
            // docs/API.md: responses are plain text unless the caller asks for JSON. Deciding
            // this from the raw header instead of Express's negotiation is what made the
            // router answer JSON to a caller that sent no Accept at all.
            expect(createSuccessResponse({...mockResult}, false, false).headers['Content-Type']).toBe(
                'text/plain; charset=utf-8',
            );
            expect(createSuccessResponse({...mockResult}, false, true).headers['Content-Type']).toBe(
                'application/json; charset=utf-8',
            );
        });

        it('should create plain text response when requested', () => {
            const result = {...mockResult};
            const response = createSuccessResponse(result, false, false);

            expect(response.statusCode).toBe(200);
            expect(response.headers['Content-Type']).toBe('text/plain; charset=utf-8');
            expect(response.body).toContain('# Compilation provided by Compiler Explorer');
            expect(response.body).toContain('mov eax, 42');
            expect(response.body).toContain('ret');
            expect(response.body).toContain('Compilation successful');
        });

        it('should filter ANSI escape sequences when requested', () => {
            const resultWithAnsi = {
                ...mockResult,
                asm: [{text: '\x1b[31mmov eax, 42\x1b[0m'}],
            };

            const response = createSuccessResponse(resultWithAnsi, true, false);

            expect(response.body).toContain('mov eax, 42');
            expect(response.body).not.toContain('\x1b[31m');
            expect(response.body).not.toContain('\x1b[0m');
        });

        it('should include execution results in text format', () => {
            const resultWithExecution = {
                ...mockResult,
                execResult: {
                    code: 0,
                    stdout: [{text: 'Program output'}],
                    stderr: [{text: 'Warning message'}],
                },
            };

            const response = createSuccessResponse(resultWithExecution, false, false);

            expect(response.body).toContain('Execution result with exit code 0');
            expect(response.body).toContain('Program output');
            expect(response.body).toContain('Warning message');
        });

        it('should handle compilation errors in text format', () => {
            const errorResult = {
                ...mockResult,
                code: 1,
                stderr: [{text: 'Compilation error'}],
            };

            const response = createSuccessResponse(errorResult, false, false);

            expect(response.body).toContain('Compiler exited with result code 1');
            expect(response.body).toContain('Compilation error');
        });
    });
});
