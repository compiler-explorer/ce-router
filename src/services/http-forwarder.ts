import axios from 'axios';

export interface ForwardResponse {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
}

export async function forwardToEnvironmentUrl(
    compilerId: string,
    targetUrl: string,
    body: string,
    isCmake: boolean,
    headers: Record<string, string | string[]>,
): Promise<ForwardResponse> {
    try {
        // Build the full URL for the request
        const endpoint = isCmake ? 'cmake' : 'compile';
        const fullUrl = `${targetUrl.replace(/\/$/, '')}/api/compiler/${compilerId}/${endpoint}`;

        console.info(`Forwarding ${endpoint} request for ${compilerId} to: ${fullUrl}`);

        // Prepare headers, converting string arrays to strings
        const forwardHeaders: Record<string, string> = {};
        Object.entries(headers).forEach(([key, value]) => {
            if (Array.isArray(value)) {
                forwardHeaders[key] = value.join(', ');
            } else {
                forwardHeaders[key] = value;
            }
        });

        // Remove hop-by-hop headers
        delete forwardHeaders['connection'];
        delete forwardHeaders['upgrade'];
        delete forwardHeaders['proxy-authenticate'];
        delete forwardHeaders['proxy-authorization'];
        delete forwardHeaders['te'];
        delete forwardHeaders['trailers'];
        delete forwardHeaders['transfer-encoding'];

        // Make the HTTP request
        const response = await axios({
            method: 'POST',
            url: fullUrl,
            data: body,
            headers: forwardHeaders,
            timeout: 60000, // 60 second timeout
            validateStatus: () => true, // Don't throw on any status code
        });

        console.info(`Forwarding response status: ${response.status}`);

        return {
            statusCode: response.status,
            headers: response.headers as Record<string, string>,
            body: typeof response.data === 'string' ? response.data : JSON.stringify(response.data),
        };
    } catch (error) {
        console.error(`HTTP forwarding error:`, error);

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
