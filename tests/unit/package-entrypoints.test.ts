import DexalotClientDefault, {
    DexalotClient,
    createConfig,
    getLogger,
    getVersion,
    MemoryCache,
    Result,
    version,
} from '../../src/index';
import * as internal from '../../src/internal';
import { generateSecretsVaultKey } from '../../src/secrets-vault';
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

    it('exports getLogger same as internal', () => {
        expect(getLogger).toBe(internal.getLogger);
        const log = getLogger('test');
        expect(typeof log.info).toBe('function');
    });

    it('secrets-vault subpath exports key helper', () => {
        expect(typeof generateSecretsVaultKey()).toBe('string');
        expect(generateSecretsVaultKey().length).toBeGreaterThan(10);
    });

    it('internal barrel does not pull secrets vault (browser-safe surface)', () => {
        expect((internal as Record<string, unknown>).generateSecretsVaultKey).toBeUndefined();
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
