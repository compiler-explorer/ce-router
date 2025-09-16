import {describe, expect, it} from 'vitest';
import {buildForwardUrl, filterResponseHeaders, prepareForwardHeaders} from '../../src/services/http-forwarder.js';

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

        it('should remove transfer-encoding header to prevent conflicts with content-length', () => {
            const headers = {
                'content-type': 'application/json',
                'transfer-encoding': 'chunked',
                'content-length': '1234',
                'x-custom-header': 'value',
            };
            const result = prepareForwardHeaders(headers);
            expect(result['transfer-encoding']).toBeUndefined();
            expect(result['content-type']).toBe('application/json');
            expect(result['content-length']).toBe('1234');
            expect(result['x-custom-header']).toBe('value');
        });
    });

    describe('filterResponseHeaders', () => {
        it('should remove transfer-encoding to prevent conflicts with content-length', () => {
            const headers = {
                'content-type': 'application/json; charset=utf-8',
                'transfer-encoding': 'chunked',
                'cache-control': 'public, max-age=600',
                etag: 'W/"1ef26-abc123"',
                server: 'nginx/1.18.0 (Ubuntu)',
                'x-powered-by': 'Express',
            };
            const result = filterResponseHeaders(headers);

            expect(result['transfer-encoding']).toBeUndefined();
            expect(result['content-type']).toBe('application/json; charset=utf-8');
            expect(result['cache-control']).toBe('public, max-age=600');
            expect(result['etag']).toBe('W/"1ef26-abc123"');
            expect(result['server']).toBe('nginx/1.18.0 (Ubuntu)');
            expect(result['x-powered-by']).toBe('Express');
        });

        it('should remove hop-by-hop headers', () => {
            const headers = {
                'content-type': 'application/json',
                connection: 'keep-alive',
                upgrade: 'websocket',
                'proxy-connection': 'keep-alive',
                'keep-alive': 'timeout=5, max=1000',
                'x-custom-header': 'should-stay',
            };
            const result = filterResponseHeaders(headers);

            expect(result['connection']).toBeUndefined();
            expect(result['upgrade']).toBeUndefined();
            expect(result['proxy-connection']).toBeUndefined();
            expect(result['keep-alive']).toBeUndefined();
            expect(result['content-type']).toBe('application/json');
            expect(result['x-custom-header']).toBe('should-stay');
        });

        it('should remove via header as proxies will add their own', () => {
            const headers = {
                'content-type': 'text/html',
                via: '1.1 example.cloudfront.net (CloudFront)',
                'x-cache': 'Miss from cloudfront',
                'x-amz-cf-id': 'abc123',
            };
            const result = filterResponseHeaders(headers);

            expect(result['via']).toBeUndefined();
            expect(result['content-type']).toBe('text/html');
            expect(result['x-cache']).toBe('Miss from cloudfront');
            expect(result['x-amz-cf-id']).toBe('abc123');
        });

        it('should handle GPU server response headers correctly', () => {
            // Real headers from GPU server that were causing 502 errors
            const headers = {
                'access-control-allow-headers': 'Origin, X-Requested-With, Content-Type, Accept',
                'access-control-allow-origin': '*',
                'cache-control': 'public, max-age=600',
                connection: 'keep-alive',
                'content-type': 'application/json; charset=utf-8',
                date: 'Mon, 15 Sep 2025 22:13:42 GMT',
                etag: 'W/"1ef27-jpK8Ur31gWq7/iVuklGaPtpaHOc"',
                server: 'nginx/1.18.0 (Ubuntu)',
                'transfer-encoding': 'chunked', // This was causing the 502!
                vary: 'Accept-Encoding',
                via: '1.1 23bb75571f07e0a7a182023119364d7e.cloudfront.net (CloudFront)',
                'x-amz-cf-id': 'Jo8tsEeYLW3f5KSYmes429jHlAd62WoiAWZoYM5aRF9PbxKp1qdBqw==',
                'x-amz-cf-pop': 'IAD55-P7',
                'x-cache': 'Miss from cloudfront',
                'x-powered-by': 'Express',
            };
            const result = filterResponseHeaders(headers);

            // Should remove the problematic headers
            expect(result['transfer-encoding']).toBeUndefined();
            expect(result['connection']).toBeUndefined();
            expect(result['via']).toBeUndefined();

            // Should keep the good headers
            expect(result['content-type']).toBe('application/json; charset=utf-8');
            expect(result['access-control-allow-origin']).toBe('*');
            expect(result['cache-control']).toBe('public, max-age=600');
            expect(result['etag']).toBe('W/"1ef27-jpK8Ur31gWq7/iVuklGaPtpaHOc"');
            expect(result['server']).toBe('nginx/1.18.0 (Ubuntu)');
            expect(result['x-powered-by']).toBe('Express');
        });

        it('should handle empty headers object', () => {
            const headers = {};
            const result = filterResponseHeaders(headers);
            expect(result).toEqual({});
        });

        it('should not modify input headers object', () => {
            const headers = {
                'content-type': 'application/json',
                'transfer-encoding': 'chunked',
                connection: 'keep-alive',
            };
            const original = {...headers};
            filterResponseHeaders(headers);

            // Original should be unchanged
            expect(headers).toEqual(original);
        });
    });
});
