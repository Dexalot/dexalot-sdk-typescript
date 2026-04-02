import { TransferClient } from './transfer.js';
import { Utils } from '../utils/index.js';
import { configureLogging, type LogLevel } from '../utils/observability.js';
import { version } from '../version.js';

export class DexalotClient extends TransferClient {
    /** Human-readable ↔ atomic unit conversion (parity with Python `DexalotClient.unit_conversion`). */
    static unitConversion(amount: string | number, decimals: number, toBase: boolean = true): string {
        return Utils.unitConversion(amount, decimals, toBase);
    }

    /** SDK logging setup (parity with Python `DexalotClient.configure_logging`). */
    static configureLogging(logLevel?: string, logFormat: 'console' | 'json' = 'console'): void {
        configureLogging(logLevel as LogLevel | undefined, logFormat);
    }

    /** Package version string (parity with Python `get_version`). */
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
