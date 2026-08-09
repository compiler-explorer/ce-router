import axios from 'axios';
import {logger} from '../lib/logger.js';
import {CMAKE_BUILD_SYSTEM} from '../utils/index.js';

export interface ForwardResponse {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
}

/**
 * The endpoint a request wants, relative to a compiler's API path. CMake keeps its own permanent spelling rather than
 * going to /build/cmake, because the environment being forwarded to is not deployed in lockstep with this one and may
 * predate the generic route -- the same reason the backend proxies CMake to sub-servers the old way.
 */
export function endpointFor(buildSystem: string | undefined): string {
    if (!buildSystem) return 'compile';
    if (buildSystem === CMAKE_BUILD_SYSTEM) return CMAKE_BUILD_SYSTEM;
    return `build/${buildSystem}`;
}

/**
 * The URL to forward to. The routing table stores one URL per compiler with an endpoint already on the end of it, so
 * the endpoint the request actually asked for has to replace it -- otherwise a project build would arrive at the
 * target as a plain compilation of the project's manifest.
 *
 * A stored URL not ending in an endpoint this recognises is forwarded unchanged, since guessing where to graft the
 * endpoint on would be worse than leaving a working route alone.
 */
export function buildForwardUrl(targetUrl: string, buildSystem?: string): string {
    const fullUrl = targetUrl.replace(/\/$/, '');
    const endpoint = endpointFor(buildSystem);

    const withoutEndpoint = stripEndpoint(fullUrl);
    if (withoutEndpoint === null) {
        if (buildSystem) {
            logger.warn(
                `Target URL ${fullUrl} does not end in a known endpoint; forwarding ${endpoint} request unchanged`,
            );
        }
        return fullUrl;
    }

    return `${withoutEndpoint}/${endpoint}`;
}

/** The target URL with its trailing endpoint removed, or null if it does not end in one we put there. */
function stripEndpoint(fullUrl: string): string | null {
    const parts = fullUrl.split('/');
    const last = parts[parts.length - 1];

    if (last === 'compile' || last === CMAKE_BUILD_SYSTEM) return parts.slice(0, -1).join('/');
    // A URL already pointing at the generic endpoint, e.g. .../api/compiler/foo/build/cargo
    if (parts.length >= 2 && parts[parts.length - 2] === 'build') return parts.slice(0, -2).join('/');
    return null;
}

export function prepareForwardHeaders(headers: Record<string, string | string[]>): Record<string, string> {
    const forwardHeaders: Record<string, string> = {};
    Object.entries(headers).forEach(([key, value]) => {
        if (Array.isArray(value)) {
            forwardHeaders[key] = value.join(', ');
        } else {
            forwardHeaders[key] = value;
        }
    });

    // Remove hop-by-hop headers and headers that conflict with our processing
    delete forwardHeaders['connection'];
    delete forwardHeaders['upgrade'];
    delete forwardHeaders['proxy-authenticate'];
    delete forwardHeaders['proxy-authorization'];
    delete forwardHeaders['te'];
    delete forwardHeaders['trailers'];
    delete forwardHeaders['transfer-encoding']; // Conflicts with content-length we set

    return forwardHeaders;
}

export function filterResponseHeaders(headers: Record<string, string>): Record<string, string> {
    const filteredHeaders = {...headers};

    // Remove headers that conflict with content-length or cause HTTP protocol violations
    delete filteredHeaders['transfer-encoding']; // Conflicts with content-length

    // Remove hop-by-hop headers that shouldn't be forwarded
    delete filteredHeaders['connection'];
    delete filteredHeaders['upgrade'];
    delete filteredHeaders['proxy-connection'];
    delete filteredHeaders['keep-alive'];

    // Remove headers that proxies typically handle themselves
    delete filteredHeaders['via']; // Will be added by ALB/CloudFront

    return filteredHeaders;
}

/** Forwards a request to a URL-routed compiler, at whichever endpoint of it the request asked for. */
export async function forwardToEnvironmentUrl(
    compilerId: string,
    targetUrl: string,
    body: string,
    buildSystem: string | undefined,
    headers: Record<string, string | string[]>,
): Promise<ForwardResponse> {
    try {
        const fullUrl = buildForwardUrl(targetUrl, buildSystem);

        logger.info(`Forwarding ${buildSystem ?? 'compile'} request for ${compilerId} to: ${fullUrl}`);

        const forwardHeaders = prepareForwardHeaders(headers);
        logger.debug('Forward headers:', forwardHeaders);

        // Make the HTTP request
        logger.debug(`Making POST request to ${fullUrl} with body length: ${body.length}`);
        const response = await axios({
            method: 'POST',
            url: fullUrl,
            data: body,
            headers: forwardHeaders,
            timeout: 60000, // 60 second timeout
            validateStatus: () => true, // Don't throw on any status code
            maxContentLength: Number.POSITIVE_INFINITY,
            maxBodyLength: Number.POSITIVE_INFINITY,
            responseType: 'text', // Force text response to avoid parsing issues
            transformResponse: [data => data], // Don't let axios parse the response
        });

        const responseBody = response.data || '';
        logger.debug(
            `Received response from ${fullUrl}: status=${response.status}, body length=${responseBody.length}`,
        );

        // Clean response headers to prevent conflicts
        const cleanResponseHeaders = filterResponseHeaders(response.headers as Record<string, string>);

        const result = {
            statusCode: response.status,
            headers: cleanResponseHeaders,
            body: responseBody,
        };
        return result;
    } catch (error) {
        logger.error('HTTP forwarding error:', error);

        if (axios.isAxiosError(error)) {
            if (error.code === 'ECONNABORTED') {
                throw new Error(`Request timeout to ${targetUrl}`);
            }
            if (error.response) {
                return {
                    statusCode: error.response.status,
                    headers: error.response.headers as Record<string, string>,
                    body:
                        typeof error.response.data === 'string'
                            ? error.response.data
                            : JSON.stringify(error.response.data),
                };
            }
        }

        throw new Error(`Failed to forward request: ${(error as Error).message}`);
    }
}
