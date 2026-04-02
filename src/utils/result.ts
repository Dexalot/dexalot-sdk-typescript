/**
 * Generic Result type for consistent error handling.
 * Matches Python SDK's Result[T] implementation.
 */
export class Result<T> {
    private constructor(
        public readonly success: boolean,
        public readonly data: T | null,
        public readonly error: string | null
    ) {}

    /**
     * Create a successful result with data.
     */
    static ok<T>(data: T): Result<T> {
        return new Result<T>(true, data, null);
    }

    /**
     * Create a failed result with an error message.
     */
    static fail<T>(error: string): Result<T> {
        return new Result<T>(false, null, error);
    }

    /**
     * Check if the result is successful (for boolean coercion).
     */
    isOk(): boolean {
        return this.success;
    }

    /**
     * Check if the result is a failure.
     */
    isErr(): boolean {
        return !this.success;
    }

    /**
     * Get the data or throw an error if the result is a failure.
     */
    unwrap(): T {
        if (!this.success || this.data === null) {
            throw new Error(this.error || 'Result is not successful');
        }
        return this.data;
    }

    /**
     * Get the data or return a default value if the result is a failure.
     */
    unwrapOr(defaultValue: T): T {
        if (!this.success || this.data === null) {
            return defaultValue;
        }
        return this.data;
    }

    /**
     * Map the data to a new type if the result is successful.
     */
    map<U>(fn: (data: T) => U): Result<U> {
        if (!this.success || this.data === null) {
            return Result.fail<U>(this.error || 'Result is not successful');
        }
        return Result.ok(fn(this.data));
    }

    /**
     * Chain another Result-returning operation if this result is successful.
     */
    andThen<U>(fn: (data: T) => Result<U>): Result<U> {
        if (!this.success || this.data === null) {
            return Result.fail<U>(this.error || 'Result is not successful');
        }
        return fn(this.data);
    }
}
