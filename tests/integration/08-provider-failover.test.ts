/**
 * Integration: RPC URL list registration and ProviderManager failover selection.
 *
 * Sets DEXALOT_RPC_43113 to two endpoints for Fuji before client init, then asserts the
 * provider manager registered both and that getProvider skips the primary after markFailure.
 */
import { createFreshTestClient } from './helpers';
import { DexalotClient } from '../../src/core/client';

const FUJI_CHAIN_ID = 43113;
const FUJI_RPC_PUBLIC = 'https://api.avax-test.network/ext/bc/C/rpc';

describe('Integration: Provider RPC list & failover', () => {
    let savedRpc43113: string | undefined;

    beforeAll(() => {
        savedRpc43113 = process.env.DEXALOT_RPC_43113;
    });

    afterAll(() => {
        if (savedRpc43113 === undefined) {
            delete process.env.DEXALOT_RPC_43113;
        } else {
            process.env.DEXALOT_RPC_43113 = savedRpc43113;
        }
    });

    function fujiChainName(c: DexalotClient): string {
        const name = Object.entries(c.chainConfig).find(([, cfg]) => cfg.chain_id === FUJI_CHAIN_ID)?.[0];
        if (!name) {
            throw new Error(`No chain with chain_id ${FUJI_CHAIN_ID} in chainConfig after initialize()`);
        }
        return name;
    }

    it('registers multiple RPC URLs from comma-separated DEXALOT_RPC_43113', async () => {
        process.env.DEXALOT_RPC_43113 = `${FUJI_RPC_PUBLIC},${FUJI_RPC_PUBLIC}`;

        const client = await createFreshTestClient({});
        try {
            const pm = client._providerManager;
            expect(pm).not.toBeNull();

            const chainName = fujiChainName(client);
            expect(pm!.getProviderCount(chainName)).toBeGreaterThanOrEqual(2);
            console.log(`✅ Provider list for ${chainName}: count=${pm!.getProviderCount(chainName)}`);
        } finally {
            client.close();
        }
    }, 90000);

    it('getProvider returns a backup index after primary is marked unhealthy', async () => {
        process.env.DEXALOT_RPC_43113 = `${FUJI_RPC_PUBLIC},${FUJI_RPC_PUBLIC}`;

        const client = await createFreshTestClient({});
        try {
            const pm = client._providerManager!;
            const chainName = fujiChainName(client);
            expect(pm.getProviderCount(chainName)).toBeGreaterThanOrEqual(2);

            const maxFailures = client.config.providerFailoverMaxFailures;
            for (let i = 0; i < maxFailures; i++) {
                pm.markFailure(chainName, 0);
            }

            const p = pm.getProvider(chainName);
            expect(p).not.toBeNull();
            const idx = pm.getProviderIndex(chainName, p!);
            expect(idx).not.toBeNull();
            expect(idx).toBeGreaterThan(0);
            console.log('✅ ProviderManager failover index selection passed');
        } finally {
            client.close();
        }
    }, 90000);
});
