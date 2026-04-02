import { TransferClient } from './transfer.js';
import { Utils } from '../utils/index.js';
import { configureLogging, type LogLevel } from '../utils/observability.js';
import { version } from '../version.js';

export class DexalotClient extends TransferClient {
    /** Convert between human-readable token amounts and atomic (wei-style) integers. */
    static unitConversion(amount: string | number, decimals: number, toBase: boolean = true): string {
        return Utils.unitConversion(amount, decimals, toBase);
    }

    /** Configure global log level and console/json formatting. */
    static configureLogging(logLevel?: string, logFormat: 'console' | 'json' = 'console'): void {
        configureLogging(logLevel as LogLevel | undefined, logFormat);
    }

    /** Package version string from `version.ts`. */
    static getVersion(): string {
        return version;
    }

    /**
     * Trigger explicit login/signature flow.
     */
    public async login(): Promise<void> {
        if (this.signer) {
            await this._getAuthHeaders();
        }
    }
}
