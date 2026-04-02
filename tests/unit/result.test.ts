import { Result } from '../../src/utils/result';

describe('Result', () => {
    describe('constructor with default error parameter', () => {
        it('should create Result with default error=null when error not provided', () => {
            const result = Result.ok('test');
            expect(result.success).toBe(true);
            expect(result.data).toBe('test');
            expect(result.error).toBe(null);
        });

        it('should create Result with explicit error', () => {
            const result = Result.fail('error message');
            expect(result.success).toBe(false);
            expect(result.data).toBe(null);
            expect(result.error).toBe('error message');
        });
    });

    describe('ok', () => {
        it('should create successful result', () => {
            const result = Result.ok('data');
            expect(result.success).toBe(true);
            expect(result.data).toBe('data');
            expect(result.error).toBe(null);
        });
    });

    describe('fail', () => {
        it('should create failed result', () => {
            const result = Result.fail('error');
            expect(result.success).toBe(false);
            expect(result.data).toBe(null);
            expect(result.error).toBe('error');
        });
    });

    describe('isOk', () => {
        it('should return true for successful result', () => {
            const result = Result.ok('data');
            expect(result.isOk()).toBe(true);
        });

        it('should return false for failed result', () => {
            const result = Result.fail('error');
            expect(result.isOk()).toBe(false);
        });
    });

    describe('isErr', () => {
        it('should return false for successful result', () => {
            const result = Result.ok('data');
            expect(result.isErr()).toBe(false);
        });

        it('should return true for failed result', () => {
            const result = Result.fail('error');
            expect(result.isErr()).toBe(true);
        });
    });

    describe('unwrap', () => {
        it('should return data for successful result', () => {
            const result = Result.ok('data');
            expect(result.unwrap()).toBe('data');
        });

        it('should throw error for failed result', () => {
            const result = Result.fail('error');
            expect(() => result.unwrap()).toThrow('error');
        });

        it('should throw default error when error is null', () => {
            // This tests the branch where error is null
            const result = Result.fail('');
            expect(() => result.unwrap()).toThrow('Result is not successful');
        });
    });

    describe('unwrapOr', () => {
        it('should return data for successful result', () => {
            const result = Result.ok('data');
            expect(result.unwrapOr('default')).toBe('data');
        });

        it('should return default for failed result', () => {
            const result = Result.fail('error');
            expect(result.unwrapOr('default')).toBe('default');
        });
    });

    describe('map', () => {
        it('should map data for successful result', () => {
            const result = Result.ok(5);
            const mapped = result.map(x => x * 2);
            expect(mapped.success).toBe(true);
            expect(mapped.data).toBe(10);
        });

        it('should return failure for failed result', () => {
            const result = Result.fail('error');
            const mapped = result.map(x => x * 2);
            expect(mapped.success).toBe(false);
            expect(mapped.error).toBe('error');
        });
    });

    describe('andThen', () => {
        it('should chain operations for successful result', () => {
            const result = Result.ok(5);
            const chained = result.andThen(x => Result.ok(x * 2));
            expect(chained.success).toBe(true);
            expect(chained.data).toBe(10);
        });

        it('should return failure for failed result', () => {
            const result = Result.fail('error');
            const chained = result.andThen(x => Result.ok(x * 2));
            expect(chained.success).toBe(false);
            expect(chained.error).toBe('error');
        });
    });
});
