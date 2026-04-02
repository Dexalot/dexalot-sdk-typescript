/**
 * Isolated suite: mock `os` before loading secretsVault so tilde expansion can hit
 * win32 + no USERPROFILE/HOMEDRIVE → os.homedir() fallback (secretsVault tildeHomeDir).
 */
import * as fs from 'fs';

jest.mock('os', () => {
    const path = require('path') as typeof import('path');
    const actual = jest.requireActual<typeof import('os')>('os');
    const fakeHomeDir = path.join(actual.tmpdir(), 'dexalot-tilde-fake-home');
    return {
        ...actual,
        homedir: () => fakeHomeDir,
    };
});

import * as os from 'os';
import * as path from 'path';
import { generateSecretsVaultKey, secretsVaultSet } from '../../src/utils/secretsVault';

describe('secretsVault tilde expansion (mocked os.homedir)', () => {
    const originalPlatform = process.platform;
    const fakeHome = os.homedir();

    beforeAll(() => {
        fs.mkdirSync(fakeHome, { recursive: true });
    });

    afterAll(() => {
        if (fs.existsSync(fakeHome)) {
            fs.rmSync(fakeHome, { recursive: true, force: true });
        }
    });

    afterEach(() => {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });

    it('resolves ~/ via os.homedir() when win32 has no USERPROFILE/HOMEDRIVE', () => {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        const prevUp = process.env.USERPROFILE;
        const prevHd = process.env.HOMEDRIVE;
        const prevHp = process.env.HOMEPATH;
        delete process.env.USERPROFILE;
        delete process.env.HOMEDRIVE;
        delete process.env.HOMEPATH;
        try {
            const base = `vault-win32-${Date.now()}.db`;
            const tildePath = `~/${base}`;
            const resolved = path.join(fakeHome, base);
            const encKey = generateSecretsVaultKey();
            const setResult = secretsVaultSet(tildePath, 'K_WIN', 'v', encKey);
            expect(setResult.success).toBe(true);
            expect(fs.existsSync(resolved)).toBe(true);
            fs.unlinkSync(resolved);
        } finally {
            if (prevUp !== undefined) process.env.USERPROFILE = prevUp;
            else delete process.env.USERPROFILE;
            if (prevHd !== undefined) process.env.HOMEDRIVE = prevHd;
            else delete process.env.HOMEDRIVE;
            if (prevHp !== undefined) process.env.HOMEPATH = prevHp;
            else delete process.env.HOMEPATH;
        }
    });
});
