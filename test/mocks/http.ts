import type {AxiosResponse} from 'axios';
import {vi} from 'vitest';

export const mockAxios = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    patch: vi.fn(),
    request: vi.fn(),
    create: vi.fn(() => mockAxios),
    defaults: {
        headers: {
            common: {},
            get: {},
            post: {},
            put: {},
            delete: {},
            patch: {},
        },
    },
};

export const createMockResponse = <T = any>(data: T, status = 200): AxiosResponse<T> => ({
    data,
    status,
    statusText: 'OK',
    headers: {},
    config: {} as any,
});

export const createMockError = (message: string, code?: string, status?: number) => {
    const error: any = new Error(message);
    error.code = code;
    if (status) {
        error.response = {
            status,
            data: {error: message},
        };
    }
    return error;
};
