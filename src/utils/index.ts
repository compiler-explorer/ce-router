import {v4 as uuidv4} from 'uuid';
import {logger} from '../lib/logger.js';

const TRIM_SLASHES_REGEX = /^\/+|\/+$/g;
const TEXT_BANNER = 'Compilation provided by Compiler Explorer at https://godbolt.org/';

export function generateGuid(): string {
    return uuidv4();
}

export function extractCompilerId(path: string): string | null {
    try {
        const pathParts = path.replaceAll(TRIM_SLASHES_REGEX, '').split('/');

        // Production format: /api/compiler/{compiler_id}/compile
        if (pathParts.length >= 4 && pathParts[0] === 'api' && pathParts[1] === 'compiler') {
            return pathParts[2];
        }

        // Other environments format: /{env}/api/compiler/{compiler_id}/compile
        if (pathParts.length >= 5 && pathParts[1] === 'api' && pathParts[2] === 'compiler') {
            return pathParts[3];
        }
    } catch (error) {
        // Ignore parse errors
    }
    return null;
}

export function isCmakeRequest(path: string): boolean {
    return path.endsWith('/cmake');
}

export function parseRequestBody(body: string, contentType?: string): Record<string, any> {
    if (!body) return {};

    // Check if content type indicates JSON
    if (contentType?.toLowerCase().includes('application/json')) {
        try {
            return JSON.parse(body);
        } catch (error) {
            logger.warn('Failed to parse JSON body, treating as plain text');
            return {source: body};
        }
    } else {
        // Plain text body - treat as source code
        return {source: body};
    }
}

function textify(array: Array<{text: string}> | undefined, filterAnsi: boolean): string {
    const text = (array || []).map(line => line.text).join('\n');
    if (filterAnsi) {
        // Remove ANSI escape sequences
        return text.replaceAll(/(\x9B|\x1B\[)[\d:;<=>?]*[ -/]*[@-~]/g, '');
    }
    return text;
}

function isEmpty(value: any): boolean {
    return (
        value === null ||
        value === undefined ||
        (typeof value === 'string' && value.trim() === '') ||
        (Array.isArray(value) && value.length === 0) ||
        (typeof value === 'object' && Object.keys(value).length === 0)
    );
}

export interface CompilationResult {
    guid?: string;
    s3Key?: string;
    asm?: Array<{text: string}>;
    code?: number;
    stdout?: Array<{text: string}>;
    stderr?: Array<{text: string}>;
    execResult?: {
        code: number;
        stdout?: Array<{text: string}>;
        stderr?: Array<{text: string}>;
    };
    [key: string]: any;
}

export interface ApiResponse {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
}

export function createErrorResponse(statusCode: number, message: string): ApiResponse {
    return {
        statusCode,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization',
        },
        body: JSON.stringify({error: message}),
    };
}

export function createSuccessResponse(
    result: CompilationResult,
    filterAnsi: boolean,
    acceptHeader: string,
): ApiResponse {
    // Clean up internal fields
    delete result.guid;
    delete result.s3Key;

    // Determine response format based on Accept header
    if (acceptHeader?.toLowerCase().includes('text/plain')) {
        // Plain text response
        let body = '';

        try {
            if (!isEmpty(TEXT_BANNER)) body += '# ' + TEXT_BANNER + '\n';
            body += textify(result.asm, filterAnsi);
            if (result.code !== 0) body += '\n# Compiler exited with result code ' + result.code;
            if (!isEmpty(result.stdout)) body += '\nStandard out:\n' + textify(result.stdout, filterAnsi);
            if (!isEmpty(result.stderr)) body += '\nStandard error:\n' + textify(result.stderr, filterAnsi);

            if (result.execResult) {
                body += '\n\n# Execution result with exit code ' + result.execResult.code + '\n';
                if (!isEmpty(result.execResult.stdout)) {
                    body += '# Standard out:\n' + textify(result.execResult.stdout, filterAnsi);
                }
                if (!isEmpty(result.execResult.stderr)) {
                    body += '\n# Standard error:\n' + textify(result.execResult.stderr, filterAnsi);
                }
            }
        } catch (ex) {
            body += `Error handling request: ${ex}`;
        }
        body += '\n';

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization',
            },
            body,
        };
    }
    // Default to JSON response
    return {
        statusCode: 200,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization',
        },
        body: JSON.stringify(result),
    };
}
