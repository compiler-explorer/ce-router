import axios from 'axios';
import {logger} from '../lib/logger.js';

export interface ForwardResponse {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
}

export function buildForwardUrl(targetUrl: string): string {
    return targetUrl.replace(/\/$/, '');
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

export async function forwardToEnvironmentUrl(
    compilerId: string,
    targetUrl: string,
    body: string,
    isCmake: boolean,
    headers: Record<string, string | string[]>,
): Promise<ForwardResponse> {
    try {
        const fullUrl = buildForwardUrl(targetUrl);
        const endpoint = isCmake ? 'cmake' : 'compile';

        logger.info(`Forwarding ${endpoint} request for ${compilerId} to: ${fullUrl}`);

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
        const cleanResponseHeaders = {...(response.headers as Record<string, string>)};
        delete cleanResponseHeaders['transfer-encoding']; // Conflicts with content-length
        delete cleanResponseHeaders['connection'];
        delete cleanResponseHeaders['upgrade'];

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
