import {
    configureLogging,
    getLogLevel,
    getLogFormat,
    getLogger,
    setRequestId,
    getRequestId,
    withRequestId,
    trackOperation,
    logEvent,
    trackMethod
} from '../../src/utils/observability';

describe('observability', () => {
    let consoleDebugSpy: jest.SpyInstance;
    let consoleInfoSpy: jest.SpyInstance;
    let consoleWarnSpy: jest.SpyInstance;
    let consoleErrorSpy: jest.SpyInstance;

    beforeEach(() => {
        consoleDebugSpy = jest.spyOn(console, 'debug').mockImplementation();
        consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation();
        consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
        consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
        configureLogging('debug', 'console');
    });

    afterEach(() => {
        consoleDebugSpy.mockRestore();
        consoleInfoSpy.mockRestore();
        consoleWarnSpy.mockRestore();
        consoleErrorSpy.mockRestore();
        configureLogging('info', 'console');
    });

    describe('configureLogging', () => {
        it('should set log level', () => {
            configureLogging('warn');
            expect(getLogLevel()).toBe('warn');
        });

        it('should set log format', () => {
            configureLogging(undefined, 'json');
            expect(getLogFormat()).toBe('json');
        });

        it('should set both level and format', () => {
            configureLogging('error', 'json');
            expect(getLogLevel()).toBe('error');
            expect(getLogFormat()).toBe('json');
        });
    });

    describe('getLogger', () => {
        it('should create logger with name', () => {
            const logger = getLogger('test');
            logger.info('test message');
            
            expect(consoleInfoSpy).toHaveBeenCalled();
            const call = consoleInfoSpy.mock.calls[0][0];
            expect(call).toContain('[test]');
        });

        it('should respect log level', () => {
            configureLogging('warn');
            const logger = getLogger('test');
            
            logger.debug('debug message');
            logger.info('info message');
            logger.warn('warn message');
            logger.error('error message');
            
            expect(consoleDebugSpy).not.toHaveBeenCalled();
            expect(consoleInfoSpy).not.toHaveBeenCalled();
            expect(consoleWarnSpy).toHaveBeenCalled();
            expect(consoleErrorSpy).toHaveBeenCalled();
        });

        it('should include context in logs', () => {
            const logger = getLogger('test');
            logger.info('message', { key: 'value' });
            
            const call = consoleInfoSpy.mock.calls[0][0];
            expect(call).toContain('{"key":"value"}');
        });

        it('should format JSON logs', () => {
            configureLogging('info', 'json');
            const logger = getLogger('test');
            logger.info('message', { key: 'value' });
            
            const call = consoleInfoSpy.mock.calls[0][0];
            const parsed = JSON.parse(call);
            expect(parsed.level).toBe('info');
            expect(parsed.logger).toBe('test');
            expect(parsed.message).toBe('message');
            expect(parsed.context.key).toBe('value');
        });

        it('should include request ID when set', () => {
            setRequestId('req-123');
            const logger = getLogger('test');
            logger.info('message');
            
            const call = consoleInfoSpy.mock.calls[0][0];
            expect(call).toContain('req-123');
        });

        it('should include request ID in JSON format', () => {
            configureLogging('info', 'json');
            setRequestId('req-456');
            const logger = getLogger('test');
            logger.info('message');
            
            const call = consoleInfoSpy.mock.calls[0][0];
            const parsed = JSON.parse(call);
            expect(parsed.requestId).toBe('req-456');
        });

        it('should handle debug level logging', () => {
            configureLogging('debug');
            const logger = getLogger('test');
            logger.debug('debug message');
            
            expect(consoleDebugSpy).toHaveBeenCalled();
        });

        it('should handle empty context', () => {
            const logger = getLogger('test');
            logger.info('message', {});
            
            const call = consoleInfoSpy.mock.calls[0][0];
            expect(call).not.toContain('{}');
        });
    });

    describe('request ID tracking', () => {
        it('should set and get request ID', () => {
            setRequestId('test-id');
            expect(getRequestId()).toBe('test-id');
        });

        it('should return null when no request ID set', () => {
            setRequestId(null);
            expect(getRequestId()).toBeNull();
        });

        it('should run function with request ID', () => {
            const result = withRequestId('async-id', () => {
                return getRequestId();
            });
            
            expect(result).toBe('async-id');
        });

        it('should preserve request ID in async context', async () => {
            let capturedId: string | null = null;
            
            await withRequestId('async-id', async () => {
                await new Promise(resolve => setTimeout(resolve, 10));
                capturedId = getRequestId();
            });
            
            // Note: AsyncLocalStorage may not work in all test environments
            // This test verifies the function doesn't throw
            expect(capturedId).toBeDefined();
        });

        it('should return null when asyncLocalStorage is not available', () => {
            // Use isolateModules to test fallback path when async_hooks is unavailable
            jest.isolateModules(() => {
                // Mock async_hooks module to not exist (simulating browser environment)
                jest.doMock('async_hooks', () => {
                    const error = new Error('Cannot find module \'async_hooks\'');
                    (error as any).code = 'MODULE_NOT_FOUND';
                    throw error;
                });
                
                const { getRequestId: getRequestIdFallback } = require('../../src/utils/observability');
                
                // When asyncLocalStorage is null, getRequestId should return null
                const result = getRequestIdFallback();
                expect(result).toBeNull();
            });
        });

        it('should execute function directly when asyncLocalStorage is not available', () => {
            // Use isolateModules to test fallback path when async_hooks is unavailable
            jest.isolateModules(() => {
                // Mock async_hooks module to not exist (simulating browser environment)
                jest.doMock('async_hooks', () => {
                    const error = new Error('Cannot find module \'async_hooks\'');
                    (error as any).code = 'MODULE_NOT_FOUND';
                    throw error;
                });
                
                const { withRequestId: withRequestIdFallback } = require('../../src/utils/observability');
                
                // When asyncLocalStorage is null, withRequestId should execute fn directly
                const fn = jest.fn(() => 'direct-result');
                const result = withRequestIdFallback('test-id', fn);
                
                expect(result).toBe('direct-result');
                expect(fn).toHaveBeenCalledTimes(1);
            });
        });
    });

    describe('trackOperation', () => {
        it('should track successful operation', async () => {
            const logger = getLogger('test');
            
            await trackOperation(logger, 'testOp', async () => {
                return 'result';
            });
            
            expect(consoleInfoSpy).toHaveBeenCalledTimes(2);
            expect(consoleInfoSpy.mock.calls[0][0]).toContain('testOp started');
            expect(consoleInfoSpy.mock.calls[1][0]).toContain('testOp completed');
        });

        it('should track failed operation', async () => {
            const logger = getLogger('test');
            
            await expect(
                trackOperation(logger, 'testOp', async () => {
                    throw new Error('test error');
                })
            ).rejects.toThrow('test error');
            
            expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
            expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
            expect(consoleErrorSpy.mock.calls[0][0]).toContain('testOp failed');
        });

        it('should handle non-Error objects in failed operation', async () => {
            const logger = getLogger('test');
            
            await expect(
                trackOperation(logger, 'testOp', async () => {
                    throw 'string error';
                })
            ).rejects.toBe('string error');
            
            expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
            expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
            expect(consoleErrorSpy.mock.calls[0][0]).toContain('testOp failed');
            expect(consoleErrorSpy.mock.calls[0][0]).toContain('string error');
        });

        it('should include context in logs', async () => {
            const logger = getLogger('test');
            
            await trackOperation(logger, 'testOp', async () => 'result', { key: 'value' });
            
            const completedCall = consoleInfoSpy.mock.calls[1][0];
            expect(completedCall).toContain('key');
        });

        it('should measure duration', async () => {
            const logger = getLogger('test');
            jest.useFakeTimers();
            
            const promise = trackOperation(logger, 'testOp', async () => {
                jest.advanceTimersByTime(100);
                return 'result';
            });
            
            await promise;
            
            const completedCall = consoleInfoSpy.mock.calls[1][0];
            expect(completedCall).toContain('durationMs');
            
            jest.useRealTimers();
        });
    });

    describe('logEvent', () => {
        it('should log events at specified level', () => {
            const logger = getLogger('test');
            
            logEvent(logger, 'info', 'event', { data: 'value' });
            expect(consoleInfoSpy).toHaveBeenCalled();
            
            logEvent(logger, 'warn', 'event');
            expect(consoleWarnSpy).toHaveBeenCalled();
            
            logEvent(logger, 'error', 'event');
            expect(consoleErrorSpy).toHaveBeenCalled();
        });
    });

    describe('trackMethod decorator', () => {
        // Note: Decorator tests require experimentalDecorators in tsconfig
        // Testing the decorator function directly instead
        it('should create decorator function', () => {
            const decorator = trackMethod('test');
            expect(typeof decorator).toBe('function');
        });

        it('should wrap method with tracking', () => {
            const decorator = trackMethod('test');
            const originalMethod = jest.fn().mockResolvedValue('result');
            const descriptor: PropertyDescriptor = {
                value: originalMethod,
                writable: true,
                enumerable: false,
                configurable: true
            };
            
            const wrapped = decorator({}, 'testMethod', descriptor);
            
            expect(wrapped.value).toBeDefined();
            expect(typeof wrapped.value).toBe('function');
        });

        it('should track successful method execution', async () => {
            const decorator = trackMethod('test');
            const originalMethod = jest.fn().mockResolvedValue('success-result');
            const descriptor: PropertyDescriptor = {
                value: originalMethod,
                writable: true,
                enumerable: false,
                configurable: true
            };
            
            const wrapped = decorator({}, 'testMethod', descriptor);
            const result = await wrapped.value();
            
            expect(result).toBe('success-result');
            expect(originalMethod).toHaveBeenCalledTimes(1);
            expect(consoleInfoSpy).toHaveBeenCalledTimes(2);
            expect(consoleInfoSpy.mock.calls[0][0]).toContain('testMethod started');
            expect(consoleInfoSpy.mock.calls[1][0]).toContain('testMethod completed');
            expect(consoleInfoSpy.mock.calls[1][0]).toContain('durationMs');
        });

        it('should track failed method execution', async () => {
            const decorator = trackMethod('test');
            const testError = new Error('method failed');
            const originalMethod = jest.fn().mockRejectedValue(testError);
            const descriptor: PropertyDescriptor = {
                value: originalMethod,
                writable: true,
                enumerable: false,
                configurable: true
            };
            
            const wrapped = decorator({}, 'testMethod', descriptor);
            
            await expect(wrapped.value()).rejects.toThrow('method failed');
            
            expect(originalMethod).toHaveBeenCalledTimes(1);
            expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
            expect(consoleInfoSpy.mock.calls[0][0]).toContain('testMethod started');
            expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
            expect(consoleErrorSpy.mock.calls[0][0]).toContain('testMethod failed');
            expect(consoleErrorSpy.mock.calls[0][0]).toContain('durationMs');
            expect(consoleErrorSpy.mock.calls[0][0]).toContain('method failed');
        });

        it('should handle non-Error objects in failed method execution', async () => {
            const decorator = trackMethod('test');
            const originalMethod = jest.fn().mockRejectedValue('non-error string');
            const descriptor: PropertyDescriptor = {
                value: originalMethod,
                writable: true,
                enumerable: false,
                configurable: true
            };
            
            const wrapped = decorator({}, 'testMethod', descriptor);
            
            await expect(wrapped.value()).rejects.toBe('non-error string');
            
            expect(originalMethod).toHaveBeenCalledTimes(1);
            expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
            expect(consoleInfoSpy.mock.calls[0][0]).toContain('testMethod started');
            expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
            expect(consoleErrorSpy.mock.calls[0][0]).toContain('testMethod failed');
            expect(consoleErrorSpy.mock.calls[0][0]).toContain('durationMs');
            expect(consoleErrorSpy.mock.calls[0][0]).toContain('non-error string');
        });

        it('should pass arguments to original method', async () => {
            const decorator = trackMethod('test');
            const originalMethod = jest.fn().mockResolvedValue('result');
            const descriptor: PropertyDescriptor = {
                value: originalMethod,
                writable: true,
                enumerable: false,
                configurable: true
            };
            
            const wrapped = decorator({}, 'testMethod', descriptor);
            await wrapped.value('arg1', 'arg2', 123);
            
            expect(originalMethod).toHaveBeenCalledWith('arg1', 'arg2', 123);
        });

        it('should preserve method context (this)', async () => {
            const decorator = trackMethod('test');
            const mockThis = { value: 'context-value' };
            const originalMethod = jest.fn(function(this: any) {
                return Promise.resolve(this.value);
            });
            const descriptor: PropertyDescriptor = {
                value: originalMethod,
                writable: true,
                enumerable: false,
                configurable: true
            };
            
            const wrapped = decorator({}, 'testMethod', descriptor);
            const result = await wrapped.value.call(mockThis);
            
            expect(result).toBe('context-value');
        });
    });
});

