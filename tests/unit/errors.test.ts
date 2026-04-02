import { parseRevertReason, ERROR_CODES } from '../../src/errors';
import { extractUserMessage } from '../../src/utils/errorSanitizer';

describe('Errors Handling', () => {
    it('parseRevertReason should return formatted error if code exists in message', () => {
        // Find a code to test
        const code = "LA-LIZA-01";
        const description = ERROR_CODES[code];
        const errorMsg = `Some EVM revert error: ${code}`;
        
        const result = parseRevertReason(errorMsg);
        expect(result).toBe(`${code}: ${description}`);
    });

    it('parseRevertReason should return original message if code not found', () => {
        const errorMsg = "Some random error";
        const result = parseRevertReason(errorMsg);
        expect(result).toBe(errorMsg);
    });

    it('parseRevertReason should handle non-string inputs', () => {
        const errorObj = { message: "Error with LA-LIZA-01" };
        const result = parseRevertReason(errorObj as any);
        // String(obj) is [object Object] usually unless toString is distinct, 
        // but implementation uses String(errorMsg)
        // If we want to test inclusion, we should pass a stringifiable thing containing the code
        
        const customError = { toString: () => "Error LA-LIZA-01 occured" };
        const res = parseRevertReason(customError);
         expect(res).toBe(`LA-LIZA-01: ${ERROR_CODES["LA-LIZA-01"]}`);
    });
});

describe('Error Sanitization', () => {
    describe('extractUserMessage', () => {
        it('should use fallback message when error message is empty', () => {
            const error = new Error();
            error.message = '';
            const result = extractUserMessage(error);
            expect(result).toBe('An unexpected error occurred');
        });
    });
});
