import DexalotClientDefault, {
    DexalotClient,
    createConfig,
    getVersion,
    MemoryCache,
    Result,
    generateSecretsVaultKey,
    version,
} from '../../src/index';
import * as internal from '../../src/internal';
import { OrderSide, OrderType, OrderStatus } from '../../src/types/index';

describe('package entrypoints', () => {
    it('default export matches named DexalotClient', () => {
        expect(DexalotClientDefault).toBe(DexalotClient);
    });

    it('getVersion matches exported version string', () => {
        expect(typeof getVersion()).toBe('string');
        expect(version).toBe(getVersion());
    });

    it('exports Result and MemoryCache', () => {
        expect(Result.ok(1).success).toBe(true);
        expect(new MemoryCache(1000)).toBeDefined();
    });

    it('secrets vault key helper returns non-empty string', () => {
        expect(typeof generateSecretsVaultKey()).toBe('string');
        expect(generateSecretsVaultKey().length).toBeGreaterThan(10);
    });

    it('internal barrel exposes clients and config', () => {
        expect(internal.BaseClient).toBeDefined();
        expect(internal.CLOBClient).toBeDefined();
        expect(internal.SwapClient).toBeDefined();
        expect(internal.TransferClient).toBeDefined();
        expect(internal.DexalotClient).toBe(DexalotClient);
        expect(internal.createConfig).toBe(createConfig);
        expect(internal.version).toBe(version);
    });

    it('runtime enum values from types/index', () => {
        expect(OrderSide.BUY).toBe(0);
        expect(OrderSide.SELL).toBe(1);
        expect(OrderType.MARKET).toBe(0);
        expect(OrderType.LIMIT).toBe(1);
        expect(OrderStatus.NEW).toBe(3);
        expect(OrderStatus.KILLED).toBe(6);
    });

    it('DexalotClient static helpers run', () => {
        const wei = DexalotClient.unitConversion('1', 18, true);
        expect(typeof wei).toBe('string');
        DexalotClient.configureLogging('error', 'console');
        expect(DexalotClient.getVersion()).toBe(version);
    });
});
