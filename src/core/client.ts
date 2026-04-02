import { TransferClient } from './transfer.js';

export class DexalotClient extends TransferClient {
    /**
     * Trigger explicit login/signature flow.
     */
    public async login(): Promise<void> {
        if (this.signer) {
            await this._getAuthHeaders();
        }
    }
}
