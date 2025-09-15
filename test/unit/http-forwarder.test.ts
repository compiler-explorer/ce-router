import {describe, expect, it} from 'vitest';
import {buildForwardUrl, prepareForwardHeaders} from '../../src/services/http-forwarder.js';

describe('HTTP Forwarder', () => {
    describe('buildForwardUrl', () => {
        it('should use the target URL as-is when it has no trailing slash', () => {
            const targetUrl = 'https://godbolt.org/gpu/api/compiler/nvcc130/compile';
            const result = buildForwardUrl(targetUrl);
            expect(result).toBe('https://godbolt.org/gpu/api/compiler/nvcc130/compile');
        });

        it('should remove trailing slash from target URL', () => {
            const targetUrl = 'https://godbolt.org/gpu/api/compiler/nvcc130/compile/';
            const result = buildForwardUrl(targetUrl);
            expect(result).toBe('https://godbolt.org/gpu/api/compiler/nvcc130/compile');
        });

        it('should handle base URL without path', () => {
            const targetUrl = 'https://example.com/';
            const result = buildForwardUrl(targetUrl);
            expect(result).toBe('https://example.com');
        });

        it('should not modify URL without trailing slash', () => {
            const targetUrl = 'http://localhost:3000/api/compiler/gcc/compile';
            const result = buildForwardUrl(targetUrl);
            expect(result).toBe('http://localhost:3000/api/compiler/gcc/compile');
        });
    });

    describe('prepareForwardHeaders', () => {
        it('should convert string array headers to comma-separated strings', () => {
            const headers = {
                'x-custom-header': ['value1', 'value2', 'value3'],
                'content-type': 'application/json',
            };
            const result = prepareForwardHeaders(headers);
            expect(result['x-custom-header']).toBe('value1, value2, value3');
            expect(result['content-type']).toBe('application/json');
        });

        it('should remove hop-by-hop headers', () => {
            const headers = {
                'content-type': 'application/json',
                connection: 'keep-alive',
                upgrade: 'websocket',
                'proxy-authenticate': 'Basic',
                'proxy-authorization': 'Bearer token',
                te: 'trailers',
                trailers: 'X-Custom',
                'transfer-encoding': 'chunked',
                'x-custom-header': 'value',
            };
            const result = prepareForwardHeaders(headers);

            expect(result['content-type']).toBe('application/json');
            expect(result['x-custom-header']).toBe('value');
            expect(result['connection']).toBeUndefined();
            expect(result['upgrade']).toBeUndefined();
            expect(result['proxy-authenticate']).toBeUndefined();
            expect(result['proxy-authorization']).toBeUndefined();
            expect(result['te']).toBeUndefined();
            expect(result['trailers']).toBeUndefined();
            expect(result['transfer-encoding']).toBeUndefined();
        });

        it('should handle empty headers object', () => {
            const headers = {};
            const result = prepareForwardHeaders(headers);
            expect(result).toEqual({});
        });

        it('should handle headers with only string values', () => {
            const headers = {
                'content-type': 'text/plain',
                authorization: 'Bearer token123',
                'x-request-id': 'abc-123',
            };
            const result = prepareForwardHeaders(headers);
            expect(result).toEqual({
                'content-type': 'text/plain',
                authorization: 'Bearer token123',
                'x-request-id': 'abc-123',
            });
        });

        it('should handle mixed string and array headers', () => {
            const headers = {
                accept: ['text/html', 'application/json'],
                'content-type': 'application/json',
                cookie: ['session=abc', 'preference=dark'],
            };
            const result = prepareForwardHeaders(headers);
            expect(result).toEqual({
                accept: 'text/html, application/json',
                'content-type': 'application/json',
                cookie: 'session=abc, preference=dark',
            });
        });
    });
});
