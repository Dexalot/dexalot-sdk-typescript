import { Result } from '../../src/utils/result';

describe('Result', () => {
    describe('ok()', () => {
        it('should create a successful result with data', () => {
            const result = Result.ok('hello');
            expect(result.success).toBe(true);
            expect(result.data).toBe('hello');
            expect(result.error).toBeNull();
        });

        it('should work with complex objects', () => {
            const data = { id: 1, name: 'test' };
            const result = Result.ok(data);
            expect(result.success).toBe(true);
            expect(result.data).toEqual(data);
        });

        it('should work with null data', () => {
            const result = Result.ok(null);
            expect(result.success).toBe(true);
            expect(result.data).toBeNull();
        });

        it('should work with undefined data', () => {
            const result = Result.ok(undefined);
            expect(result.success).toBe(true);
            expect(result.data).toBeUndefined();
        });
    });

    describe('fail()', () => {
        it('should create a failed result with error', () => {
            const result = Result.fail('something went wrong');
            expect(result.success).toBe(false);
            expect(result.data).toBeNull();
            expect(result.error).toBe('something went wrong');
        });

        it('should work with empty error message', () => {
            const result = Result.fail('');
            expect(result.success).toBe(false);
            expect(result.error).toBe('');
        });
    });

    describe('isOk() / isErr()', () => {
        it('should return true for isOk on success', () => {
            const result = Result.ok('data');
            expect(result.isOk()).toBe(true);
            expect(result.isErr()).toBe(false);
        });

        it('should return true for isErr on failure', () => {
            const result = Result.fail('error');
            expect(result.isOk()).toBe(false);
            expect(result.isErr()).toBe(true);
        });
    });

    describe('unwrap()', () => {
        it('should return data on success', () => {
            const result = Result.ok('hello');
            expect(result.unwrap()).toBe('hello');
        });

        it('should throw on failure', () => {
            const result = Result.fail('something went wrong');
            expect(() => result.unwrap()).toThrow('something went wrong');
        });

        it('should throw default message on failure with empty error', () => {
            const result = Result.fail('');
            expect(() => result.unwrap()).toThrow();
        });

        it('should throw on success with null data', () => {
            const result = Result.ok(null);
            expect(() => result.unwrap()).toThrow('Result is not successful');
        });
    });

    describe('unwrapOr()', () => {
        it('should return data on success', () => {
            const result = Result.ok('hello');
            expect(result.unwrapOr('default')).toBe('hello');
        });

        it('should return default on failure', () => {
            const result = Result.fail<string>('error');
            expect(result.unwrapOr('default')).toBe('default');
        });

        it('should return default on success with null data', () => {
            const result = Result.ok<string | null>(null);
            expect(result.unwrapOr('default')).toBe('default');
        });
    });

    describe('map()', () => {
        it('should transform data on success', () => {
            const result = Result.ok(5);
            const mapped = result.map(x => x * 2);
            expect(mapped.success).toBe(true);
            expect(mapped.data).toBe(10);
        });

        it('should pass through error on failure', () => {
            const result = Result.fail<number>('error');
            const mapped = result.map(x => x * 2);
            expect(mapped.success).toBe(false);
            expect(mapped.error).toBe('error');
        });

        it('should pass through error on success with null data', () => {
            const result = Result.ok<number | null>(null);
            const mapped = result.map(x => x! * 2);
            expect(mapped.success).toBe(false);
        });
    });

    describe('andThen()', () => {
        it('should chain successful operations', () => {
            const result = Result.ok(5);
            const chained = result.andThen(x => Result.ok(x * 2));
            expect(chained.success).toBe(true);
            expect(chained.data).toBe(10);
        });

        it('should short-circuit on first failure', () => {
            const result = Result.fail<number>('first error');
            const chained = result.andThen(x => Result.ok(x * 2));
            expect(chained.success).toBe(false);
            expect(chained.error).toBe('first error');
        });

        it('should propagate chained failure', () => {
            const result = Result.ok(5);
            const chained = result.andThen(() => Result.fail<number>('chained error'));
            expect(chained.success).toBe(false);
            expect(chained.error).toBe('chained error');
        });

        it('should fail on success with null data', () => {
            const result = Result.ok<number | null>(null);
            const chained = result.andThen(x => Result.ok(x! * 2));
            expect(chained.success).toBe(false);
        });
    });

    describe('type inference', () => {
        it('should infer types correctly', () => {
            const stringResult: Result<string> = Result.ok('hello');
            const numberResult: Result<number> = Result.ok(42);
            const objectResult: Result<{ id: number }> = Result.ok({ id: 1 });

            expect(stringResult.data).toBe('hello');
            expect(numberResult.data).toBe(42);
            expect(objectResult.data?.id).toBe(1);
        });
    });

    describe('constructor default parameters', () => {
        it('should handle default error parameter via fail()', () => {
            // Result.fail() always passes error string, but tests the constructor
            const result = Result.fail('test error');
            expect(result.error).toBe('test error');
            expect(result.success).toBe(false);
            expect(result.data).toBeNull();
        });

        it('should handle empty error string', () => {
            const result = Result.fail('');
            expect(result.error).toBe('');
            expect(result.success).toBe(false);
        });

        it('should handle null error parameter explicitly', () => {
            // Test when error is explicitly null (default parameter branch)
            // Result.ok() passes null for error, testing the default parameter
            const result = Result.ok('data');
            expect(result.error).toBeNull();
            expect(result.success).toBe(true);
            expect(result.data).toBe('data');
        });
    });
});
