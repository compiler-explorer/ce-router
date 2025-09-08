import {describe, expect, it} from 'vitest';
import {
    createErrorResponse,
    createSuccessResponse,
    extractCompilerId,
    generateGuid,
    isCmakeRequest,
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

    describe('isCmakeRequest', () => {
        it('should return true for cmake paths', () => {
            expect(isCmakeRequest('/api/compiler/g132/cmake')).toBe(true);
            expect(isCmakeRequest('/prod/api/compiler/g132/cmake')).toBe(true);
        });

        it('should return false for compile paths', () => {
            expect(isCmakeRequest('/api/compiler/g132/compile')).toBe(false);
            expect(isCmakeRequest('/prod/api/compiler/g132/compile')).toBe(false);
        });

        it('should return false for other paths', () => {
            expect(isCmakeRequest('/api/compiler/g132')).toBe(false);
            expect(isCmakeRequest('/invalid/path')).toBe(false);
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
            const response = createSuccessResponse(result, false, 'application/json');

            expect(response.statusCode).toBe(200);
            expect(response.headers['Content-Type']).toBe('application/json; charset=utf-8');
            expect(response.headers['Access-Control-Allow-Origin']).toBe('*');

            const responseBody = JSON.parse(response.body);
            expect(responseBody.guid).toBeUndefined(); // Should be cleaned up
            expect(responseBody.s3Key).toBeUndefined(); // Should be cleaned up
            expect(responseBody.asm).toEqual([{text: 'mov eax, 42'}, {text: 'ret'}]);
            expect(responseBody.code).toBe(0);
        });

        it('should create plain text response when requested', () => {
            const result = {...mockResult};
            const response = createSuccessResponse(result, false, 'text/plain');

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

            const response = createSuccessResponse(resultWithAnsi, true, 'text/plain');

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

            const response = createSuccessResponse(resultWithExecution, false, 'text/plain');

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

            const response = createSuccessResponse(errorResult, false, 'text/plain');

            expect(response.body).toContain('Compiler exited with result code 1');
            expect(response.body).toContain('Compilation error');
        });
    });
});
