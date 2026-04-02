import { Result } from './result.js';

/**
 * Options for async retry decorator.
 */
export interface RetryOptions {
    /** Maximum number of attempts (default: 3) */
    maxAttempts?: number;
    /** Initial delay in milliseconds (default: 1000) */
    initialDelay?: number;
    /** Maximum delay in milliseconds (default: 10000) */
    maxDelay?: number;
    /** Exponential backoff base (default: 2.0) */
    exponentialBase?: number;
    /** HTTP status codes to retry on (default: [429, 500, 502, 503, 504]) */
    retryOnStatus?: number[];
    /** Whether to retry on network errors (default: true) */
    retryOnNetworkError?: boolean;
    /**
     * Exception constructors that trigger a retry even when HTTP status / network
     * heuristics do not match.
     */
    retryOnExceptions?: Array<new (...args: unknown[]) => unknown>;
}

const DEFAULT_RETRY_OPTIONS: Required<Omit<RetryOptions, 'retryOnExceptions'>> & {
    retryOnExceptions: Array<new (...args: unknown[]) => unknown>;
} = {
    maxAttempts: 3,
    initialDelay: 1000,
    maxDelay: 10000,
    exponentialBase: 2.0,
    retryOnStatus: [429, 500, 502, 503, 504],
    retryOnNetworkError: true,
    retryOnExceptions: [],
};

function matchesRetryException(
    error: unknown,
    ctors: Array<new (...args: unknown[]) => unknown>
): boolean {
    for (const C of ctors) {
        if (error instanceof C) {
            return true;
        }
    }
    return false;
}

/**
 * Check if an error is a retryable HTTP error.
 */
function isRetryableHttpError(error: unknown, retryOnStatus: number[]): boolean {
    if (error && typeof error === 'object') {
        // Axios-style error
        if ('response' in error && error.response && typeof error.response === 'object') {
            const response = error.response as { status?: number };
            if (typeof response.status === 'number') {
                return retryOnStatus.includes(response.status);
            }
        }
        // Fetch-style error with status
        if ('status' in error && typeof error.status === 'number') {
            return retryOnStatus.includes(error.status);
        }
    }
    return false;
}

/**
 * Check if an error is a network error.
 */
function isNetworkError(error: unknown): boolean {
    if (error instanceof Error) {
        const message = error.message.toLowerCase();
        return (
            message.includes('network') ||
            message.includes('econnrefused') ||
            message.includes('econnreset') ||
            message.includes('etimedout') ||
            message.includes('timeout') ||
            message.includes('socket') ||
            message.includes('fetch failed')
        );
    }
    return false;
}

/**
 * Calculate delay with exponential backoff and jitter.
 */
function calculateDelay(
    attempt: number,
    initialDelay: number,
    maxDelay: number,
    exponentialBase: number
): number {
    const delay = Math.min(
        initialDelay * Math.pow(exponentialBase, attempt - 1),
        maxDelay
    );
    // Add jitter (±10%)
    const jitter = delay * 0.1 * (Math.random() * 2 - 1);
    return Math.max(0, delay + jitter);
}

/**
 * Sleep for specified milliseconds.
 */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Async retry decorator for functions.
 * Wraps an async function with retry logic using exponential backoff.
 * 
 * @param fn - The async function to wrap
 * @param options - Retry configuration options
 * @returns Wrapped function that retries on failure
 * 
 * @example
 * const fetchWithRetry = asyncRetry(
 *     async () => fetch('https://api.example.com/data'),
 *     { maxAttempts: 3, initialDelay: 1000 }
 * );
 */
export function asyncRetry<T extends (...args: any[]) => Promise<any>>(
    fn: T,
    options: RetryOptions = {}
): T {
    const opts = {
        ...DEFAULT_RETRY_OPTIONS,
        ...options,
        retryOnExceptions: options.retryOnExceptions ?? DEFAULT_RETRY_OPTIONS.retryOnExceptions,
    };

    const wrapped = async (...args: Parameters<T>): Promise<ReturnType<T>> => {
        let lastError: unknown;

        for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
            try {
                return await fn(...args);
            } catch (error) {
                lastError = error;

                // Check if we should retry
                const exceptionMatch = matchesRetryException(error, opts.retryOnExceptions);
                const shouldRetry =
                    attempt < opts.maxAttempts &&
                    (exceptionMatch ||
                        isRetryableHttpError(error, opts.retryOnStatus) ||
                        (opts.retryOnNetworkError && isNetworkError(error)));

                if (!shouldRetry) {
                    throw error;
                }

                // Calculate delay and wait
                const delay = calculateDelay(
                    attempt,
                    opts.initialDelay,
                    opts.maxDelay,
                    opts.exponentialBase
                );
                await sleep(delay);
            }
        }

        // All attempts exhausted
        throw lastError;
    };

    return wrapped as T;
}

/**
 * Async retry decorator that returns Result<T> instead of throwing.
 * 
 * @param fn - The async function to wrap
 * @param options - Retry configuration options
 * @returns Wrapped function that returns Result<T>
 * 
 * @example
 * const fetchWithRetry = asyncRetryResult(
 *     async () => fetch('https://api.example.com/data').then(r => r.json()),
 *     { maxAttempts: 3 }
 * );
 * const result = await fetchWithRetry();
 * if (result.success) {
 *     console.log(result.data);
 * }
 */
export function asyncRetryResult<T>(
    fn: (...args: any[]) => Promise<T>,
    options: RetryOptions = {}
): (...args: any[]) => Promise<Result<T>> {
    const retryFn = asyncRetry(fn, options);

    return async (...args: any[]): Promise<Result<T>> => {
        try {
            const data = await retryFn(...args);
            return Result.ok(data);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return Result.fail(message);
        }
    };
}
