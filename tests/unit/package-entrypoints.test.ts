import DexalotClientDefault, {
    DexalotClient,
    createConfig,
    getLogger,
    getVersion,
    loadConfigFromEnv,
    MemoryCache,
    Result,
    version,
    configureLogging,
    withRequestId,
    setRequestId,
    getRequestId,
    getLogLevel,
    getLogFormat,
} from '../../src/index';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as internal from '../../src/internal';
import {
    generateSecretsVaultKey,
    secretsVaultGet,
    secretsVaultList,
    secretsVaultRemove,
    secretsVaultSet,
} from '../../src/secrets-vault';
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

    it('root config re-exports and secrets-vault subpath re-exports are callable', () => {
        expect(loadConfigFromEnv).toBe(internal.loadConfigFromEnv);
        expect(createConfig()).toBeDefined();

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexalot-entrypoint-vault-'));
        const vaultPath = path.join(tmpDir, 'vault.json');
        const key = generateSecretsVaultKey();
        try {
            expect(secretsVaultSet(vaultPath, 'ENTRY', 'value', key).success).toBe(true);
            expect(secretsVaultGet(vaultPath, 'ENTRY', key).data).toBe('value');
            expect(secretsVaultList(vaultPath).data).toEqual(['ENTRY']);
            expect(secretsVaultRemove(vaultPath, 'ENTRY').success).toBe(true);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
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
        expect(OrderStatus.NEW).toBe(0);
        expect(OrderStatus.KILLED).toBe(6);
        expect(OrderStatus.CANCEL_REJECT).toBe(7);
    });

    it('DexalotClient static helpers run', () => {
        const wei = DexalotClient.unitConversion('1', 18, true);
        expect(typeof wei).toBe('string');
        DexalotClient.configureLogging('error', 'console');
        expect(DexalotClient.getVersion()).toBe(version);
    });

    it('observability re-exports are wired through to the implementation', () => {
        // configureLogging delegates to the observability module — calling
        // it from the public surface must update the live logger state.
        configureLogging('debug', 'json');
        expect(getLogLevel()).toBe('debug');
        expect(getLogFormat()).toBe('json');
        configureLogging('error', 'console');
        expect(getLogLevel()).toBe('error');
        expect(getLogFormat()).toBe('console');

        // setRequestId / getRequestId tie into the AsyncLocalStorage-backed
        // store. withRequestId scopes a value for the duration of a
        // (sync or async) callback.
        setRequestId('outer');
        expect(getRequestId()).toBe('outer');
        const inner = withRequestId('inner', () => getRequestId());
        expect(inner).toBe('inner');
        // After the scope, outer is restored.
        expect(getRequestId()).toBe('outer');
        setRequestId(null);
    });
});
