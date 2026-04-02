/**
 * Strip paths, URLs, and stack traces from user-facing error strings.
 */

// Patterns to remove from error messages
const SENSITIVE_PATTERNS: RegExp[] = [
    // File paths (Unix and Windows)
    /(?:\/[a-zA-Z0-9_.-]+)+(?:\/[a-zA-Z0-9_.-]*)?/g,
    /(?:[A-Z]:\\[^:*?"<>|\r\n]+)/gi,
    // URLs (but keep domain for context)
    /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi,
    // Stack traces
    /at\s+\S+\s+\([^)]+\)/g,
    /at\s+\S+\s+\S+:\d+:\d+/g,
    // IP addresses
    /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
    // Private keys and hex secrets (64 hex chars)
    /0x[a-fA-F0-9]{64}/g,
    // API keys (common patterns)
    /(?:api[_-]?key|apikey|secret|token|password|auth)[=:]\s*["']?[a-zA-Z0-9_-]+["']?/gi,
    // Email addresses
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
];

// Error code mappings for user-friendly messages
const ERROR_CODE_MAP: Record<string, string> = {
    'ECONNREFUSED': 'Connection refused',
    'ECONNRESET': 'Connection reset',
    'ETIMEDOUT': 'Connection timed out',
    'ENOTFOUND': 'Host not found',
    'EPIPE': 'Connection broken',
    'EAI_AGAIN': 'DNS lookup failed',
    'CERT_HAS_EXPIRED': 'SSL certificate expired',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE': 'SSL certificate verification failed',
};

/**
 * Sanitize an error message by removing sensitive information.
 * 
 * @param error - The error to sanitize (Error object or string)
 * @param context - Optional context to prepend to the message
 * @returns Sanitized error message safe for end users
 * 
 * @example
 * try {
 *     await fetch('https://api.example.com');
 * } catch (e) {
 *     const safeMessage = sanitizeErrorMessage(e, 'fetching data');
 *     // Returns: "Error fetching data: Connection refused"
 * }
 */
export function sanitizeErrorMessage(error: Error | string, context?: string): string {
    let message: string;

    if (error instanceof Error) {
        message = error.message;
        
        // Check for known error codes
        const errorWithCode = error as Error & { code?: string };
        if (errorWithCode.code && ERROR_CODE_MAP[errorWithCode.code]) {
            message = ERROR_CODE_MAP[errorWithCode.code];
        }
    } else {
        message = String(error);
    }

    // Remove sensitive patterns
    let sanitized = message;
    for (const pattern of SENSITIVE_PATTERNS) {
        sanitized = sanitized.replace(pattern, '[redacted]');
    }

    // Remove multiple [redacted] in a row
    sanitized = sanitized.replace(/(\[redacted\]\s*)+/g, '[redacted] ');

    // Trim and clean up
    sanitized = sanitized.trim();

    // Add context if provided
    if (context) {
        return `Error ${context}: ${sanitized}`;
    }

    return sanitized;
}

/**
 * Extract a simple, user-friendly message from an error.
 * More aggressive sanitization than sanitizeErrorMessage.
 * 
 * @param error - The error to extract message from
 * @returns Simple user-friendly message
 * 
 * @example
 * const userMessage = extractUserMessage(new Error('Network timeout at /internal/path'));
 * // Returns: "Network timeout"
 */
export function extractUserMessage(error: Error): string {
    let message = error.message || 'An unexpected error occurred';

    // Check for known error codes first
    const errorWithCode = error as Error & { code?: string };
    if (errorWithCode.code && ERROR_CODE_MAP[errorWithCode.code]) {
        return ERROR_CODE_MAP[errorWithCode.code];
    }

    // Extract first sentence or phrase
    const firstSentence = message.split(/[.!?\n]/)[0];
    if (firstSentence && firstSentence.length > 0) {
        message = firstSentence;
    }

    // Remove technical prefixes
    message = message.replace(/^(Error|TypeError|ReferenceError|SyntaxError):\s*/i, '');

    // Remove paths and URLs
    for (const pattern of SENSITIVE_PATTERNS) {
        message = message.replace(pattern, '');
    }

    // Clean up whitespace
    message = message.replace(/\s+/g, ' ').trim();

    // Fallback if message is empty after sanitization
    if (!message || message === '[redacted]') {
        return 'An error occurred';
    }

    return message;
}

/**
 * Create a safe error for re-throwing.
 * Preserves the error type but sanitizes the message.
 * 
 * @param error - The original error
 * @param context - Optional context for the error
 * @returns New Error with sanitized message
 */
export function createSafeError(error: Error, context?: string): Error {
    const safeMessage = sanitizeErrorMessage(error, context);
    const safeError = new Error(safeMessage);
    safeError.name = error.name;
    return safeError;
}
