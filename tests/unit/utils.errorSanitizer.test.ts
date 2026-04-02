import { sanitizeErrorMessage, extractUserMessage, createSafeError } from '../../src/utils/errorSanitizer';

describe('errorSanitizer', () => {
    describe('sanitizeErrorMessage', () => {
        it('should sanitize file paths', () => {
            const error = new Error('Error at /home/user/secret/file.js:123');
            const result = sanitizeErrorMessage(error);
            
            expect(result).not.toContain('/home/user/secret/file.js');
            expect(result).toContain('[redacted]');
        });

        it('should sanitize Windows file paths', () => {
            const error = new Error('Error at C:\\Users\\Secret\\file.js');
            const result = sanitizeErrorMessage(error);
            
            expect(result).not.toContain('C:\\Users\\Secret\\file.js');
            expect(result).toContain('[redacted]');
        });

        it('should sanitize URLs', () => {
            const error = new Error('Failed to fetch https://api.example.com/secret?key=123');
            const result = sanitizeErrorMessage(error);
            
            expect(result).not.toContain('https://api.example.com/secret?key=123');
            expect(result).toContain('[redacted]');
        });

        it('should sanitize stack traces', () => {
            const error = new Error('Error occurred');
            error.stack = 'Error: Error occurred\n    at function (file.js:123:45)';
            const result = sanitizeErrorMessage(error);
            
            expect(result).not.toContain('at function (file.js:123:45)');
        });

        it('should sanitize IP addresses', () => {
            const error = new Error('Connection to 192.168.1.1 failed');
            const result = sanitizeErrorMessage(error);
            
            expect(result).not.toContain('192.168.1.1');
            expect(result).toContain('[redacted]');
        });

        it('should sanitize private keys', () => {
            const error = new Error('Invalid key: 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef');
            const result = sanitizeErrorMessage(error);
            
            expect(result).not.toContain('0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef');
            expect(result).toContain('[redacted]');
        });

        it('should sanitize API keys', () => {
            const error = new Error('api_key=secret123');
            const result = sanitizeErrorMessage(error);
            
            expect(result).not.toContain('secret123');
            expect(result).toContain('[redacted]');
        });

        it('should sanitize email addresses', () => {
            const error = new Error('Contact admin@example.com for help');
            const result = sanitizeErrorMessage(error);
            
            expect(result).not.toContain('admin@example.com');
            expect(result).toContain('[redacted]');
        });

        it('should map known error codes', () => {
            const error = new Error('Connection failed') as Error & { code?: string };
            error.code = 'ECONNREFUSED';
            const result = sanitizeErrorMessage(error);
            
            expect(result).toContain('Connection refused');
        });

        it('should add context when provided', () => {
            const error = new Error('Network error');
            const result = sanitizeErrorMessage(error, 'fetching data');
            
            expect(result).toContain('Error fetching data');
        });

        it('should handle string errors', () => {
            const result = sanitizeErrorMessage('Simple error message');
            
            expect(result).toBe('Simple error message');
        });

        it('should handle errors without messages', () => {
            const error = new Error();
            const result = sanitizeErrorMessage(error);
            
            expect(result).toBeDefined();
        });

        it('should clean up multiple redacted markers', () => {
            const error = new Error('Path /secret/file and URL https://api.com');
            const result = sanitizeErrorMessage(error);
            
            expect(result.split('[redacted]').length).toBeLessThanOrEqual(3);
        });
    });

    describe('extractUserMessage', () => {
        it('should extract first sentence', () => {
            const error = new Error('Network timeout occurred. Please try again later.');
            const result = extractUserMessage(error);
            
            expect(result).toBe('Network timeout occurred');
        });

        it('should remove error type prefixes', () => {
            const error = new Error('TypeError: Invalid argument');
            const result = extractUserMessage(error);
            
            expect(result).not.toContain('TypeError:');
        });

        it('should use error code mapping if available', () => {
            const error = new Error('Connection failed') as Error & { code?: string };
            error.code = 'ETIMEDOUT';
            const result = extractUserMessage(error);
            
            expect(result).toBe('Connection timed out');
        });

        it('should sanitize paths and URLs', () => {
            const error = new Error('Error at /secret/path:123');
            const result = extractUserMessage(error);
            
            expect(result).not.toContain('/secret/path');
        });

        it('should return fallback for empty messages', () => {
            const error = new Error('[redacted]');
            const result = extractUserMessage(error);
            
            expect(result).toBe('An error occurred');
        });

        it('should handle errors with only technical details', () => {
            const error = new Error('Error: /path/to/file.js:123:45');
            const result = extractUserMessage(error);
            
            expect(result).not.toContain('/path/to/file.js');
        });
    });

    describe('createSafeError', () => {
        it('should create error with sanitized message', () => {
            const original = new Error('Error at /secret/path');
            const safe = createSafeError(original, 'processing');
            
            expect(safe.message).not.toContain('/secret/path');
            expect(safe.message).toContain('Error processing');
            expect(safe.name).toBe(original.name);
        });

        it('should preserve error name', () => {
            const original = new TypeError('Invalid type');
            const safe = createSafeError(original);
            
            expect(safe.name).toBe('TypeError');
        });

        it('should handle errors without context', () => {
            const original = new Error('Simple error');
            const safe = createSafeError(original);
            
            expect(safe.message).toBeDefined();
        });
    });
});

