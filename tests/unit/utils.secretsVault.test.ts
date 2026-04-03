import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import {
    generateSecretsVaultKey,
    secretsVaultSet,
    secretsVaultGet,
    secretsVaultList,
    secretsVaultRemove,
} from '../../src/utils/secretsVault';

type VaultEntry = {
    value: string;
    created_at: string;
    updated_at: string;
};

type VaultFile = {
    format: string;
    version: number;
    entries: Record<string, VaultEntry>;
};

function readVaultFile(vaultPath: string): VaultFile {
    return JSON.parse(fs.readFileSync(vaultPath, 'utf8')) as VaultFile;
}

function writeVaultFile(vaultPath: string, data: VaultFile): void {
    fs.writeFileSync(vaultPath, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
}

describe('secretsVault', () => {
    let tmpDir: string;
    let vaultPath: string;

    beforeAll(() => {
        tmpDir = path.join(os.tmpdir(), `dexalot-vault-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        fs.mkdirSync(tmpDir, { recursive: true });
        vaultPath = path.join(tmpDir, 'test_vault.db');
    });

    afterAll(() => {
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    describe('generateSecretsVaultKey', () => {
        it('should return a URL-safe base64 string (43 chars for 32 bytes)', () => {
            const key = generateSecretsVaultKey();
            expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
            const decoded = Buffer.from(key, 'base64url');
            expect(decoded.length).toBe(32);
        });

        it('should generate unique keys on each call', () => {
            const key1 = generateSecretsVaultKey();
            const key2 = generateSecretsVaultKey();
            expect(key1).not.toBe(key2);
        });
    });

    describe('set + get roundtrip', () => {
        it('should store and retrieve a value', () => {
            const encKey = generateSecretsVaultKey();
            const setResult = secretsVaultSet(vaultPath, 'MY_SECRET', 's3cret!', encKey);
            expect(setResult.success).toBe(true);

            const getResult = secretsVaultGet(vaultPath, 'MY_SECRET', encKey);
            expect(getResult.success).toBe(true);
            expect(getResult.data).toBe('s3cret!');
        });

        it('should handle unicode values', () => {
            const encKey = generateSecretsVaultKey();
            secretsVaultSet(vaultPath, 'UNICODE', 'hello 😀 world', encKey);
            const result = secretsVaultGet(vaultPath, 'UNICODE', encKey);
            expect(result.success).toBe(true);
            expect(result.data).toBe('hello 😀 world');
        });

        it('should create a portable JSON vault file', () => {
            const encKey = generateSecretsVaultKey();
            const freshVault = path.join(tmpDir, 'json_vault.db');

            secretsVaultSet(freshVault, 'PORTABLE', 'value', encKey);
            const data = readVaultFile(freshVault);
            expect(data.format).toBe('dexalot-secrets-vault');
            expect(data.version).toBe(1);
            expect(data.entries.PORTABLE).toBeDefined();
            expect(typeof data.entries.PORTABLE.value).toBe('string');
        });
    });

    describe('get nonexistent key', () => {
        it('should return a fail result', () => {
            const encKey = generateSecretsVaultKey();
            const result = secretsVaultGet(vaultPath, 'DOES_NOT_EXIST', encKey);
            expect(result.success).toBe(false);
            expect(result.error).toContain('not found');
        });
    });

    describe('list', () => {
        it('should return sorted keys', () => {
            const freshVault = path.join(tmpDir, 'list_vault.db');
            const encKey = generateSecretsVaultKey();

            secretsVaultSet(freshVault, 'ZEBRA', 'val', encKey);
            secretsVaultSet(freshVault, 'ALPHA', 'val', encKey);
            secretsVaultSet(freshVault, 'MIDDLE', 'val', encKey);

            const result = secretsVaultList(freshVault);
            expect(result.success).toBe(true);
            expect(result.data).toEqual(['ALPHA', 'MIDDLE', 'ZEBRA']);
        });
    });

    describe('remove', () => {
        it('should remove a key so that get fails afterwards', () => {
            const freshVault = path.join(tmpDir, 'remove_vault.db');
            const encKey = generateSecretsVaultKey();

            secretsVaultSet(freshVault, 'TO_DELETE', 'val', encKey);
            expect(secretsVaultGet(freshVault, 'TO_DELETE', encKey).success).toBe(true);

            const removeResult = secretsVaultRemove(freshVault, 'TO_DELETE');
            expect(removeResult.success).toBe(true);

            const getResult = secretsVaultGet(freshVault, 'TO_DELETE', encKey);
            expect(getResult.success).toBe(false);
        });

        it('should fail when removing a nonexistent key', () => {
            const freshVault = path.join(tmpDir, 'remove_missing_vault.db');
            const encKey = generateSecretsVaultKey();

            secretsVaultSet(freshVault, 'EXISTING', 'val', encKey);

            const result = secretsVaultRemove(freshVault, 'NOPE');
            expect(result.success).toBe(false);
            expect(result.error).toContain('not found');
        });
    });

    describe('validation', () => {
        it('should fail when setting with an empty key', () => {
            const encKey = generateSecretsVaultKey();
            const result = secretsVaultSet(vaultPath, '', 'value', encKey);
            expect(result.success).toBe(false);
            expect(result.error).toContain('key must not be empty');
        });

        it('should fail when setting with an empty value', () => {
            const encKey = generateSecretsVaultKey();
            const result = secretsVaultSet(vaultPath, 'KEY', '', encKey);
            expect(result.success).toBe(false);
            expect(result.error).toContain('value must not be empty');
        });
    });

    describe('wrong encryption key', () => {
        it('should fail decryption with a different key', () => {
            const freshVault = path.join(tmpDir, 'wrong_key_vault.db');
            const encKey1 = generateSecretsVaultKey();
            const encKey2 = generateSecretsVaultKey();

            secretsVaultSet(freshVault, 'SECRET', 'topsecret', encKey1);

            const result = secretsVaultGet(freshVault, 'SECRET', encKey2);
            expect(result.success).toBe(false);
            expect(result.error).toContain('decryption failed');
        });
    });

    describe('upsert behavior', () => {
        it('should update value but preserve created_at timestamp', () => {
            const freshVault = path.join(tmpDir, 'upsert_vault.db');
            const encKey = generateSecretsVaultKey();

            secretsVaultSet(freshVault, 'KEY1', 'first', encKey);
            const before = readVaultFile(freshVault).entries.KEY1;
            expect(secretsVaultGet(freshVault, 'KEY1', encKey).data).toBe('first');

            secretsVaultSet(freshVault, 'KEY1', 'second', encKey);
            const after = readVaultFile(freshVault).entries.KEY1;
            expect(secretsVaultGet(freshVault, 'KEY1', encKey).data).toBe('second');
            expect(after.created_at).toBe(before.created_at);
            expect(after.updated_at >= before.updated_at).toBe(true);
        });
    });

    describe('Fernet error paths', () => {
        it('should fail when encrypting with invalid key length', () => {
            const shortKey = Buffer.from('tooshort').toString('base64url');
            const result = secretsVaultSet(vaultPath, 'BAD_KEY', 'value', shortKey);
            expect(result.success).toBe(false);
            expect(result.error).toContain('secretsVaultSet failed');
        });

        it('should fail when decrypting with invalid key length', () => {
            const freshVault = path.join(tmpDir, 'bad_key_decrypt.db');
            const goodKey = generateSecretsVaultKey();
            secretsVaultSet(freshVault, 'KEY', 'value', goodKey);

            const shortKey = Buffer.from('tooshort').toString('base64url');
            const result = secretsVaultGet(freshVault, 'KEY', shortKey);
            expect(result.success).toBe(false);
            expect(result.error).toContain('decryption failed');
        });

        it('should fail when Fernet token is too short', () => {
            const freshVault = path.join(tmpDir, 'short_token.db');
            const encKey = generateSecretsVaultKey();

            secretsVaultSet(freshVault, 'TRUNC', 'value', encKey);

            const data = readVaultFile(freshVault);
            data.entries.TRUNC.value = Buffer.alloc(10).toString('base64');
            writeVaultFile(freshVault, data);

            const result = secretsVaultGet(freshVault, 'TRUNC', encKey);
            expect(result.success).toBe(false);
            expect(result.error).toContain('decryption failed');
        });

        it('should fail when Fernet version byte is wrong', () => {
            const freshVault = path.join(tmpDir, 'bad_version.db');
            const encKey = generateSecretsVaultKey();

            secretsVaultSet(freshVault, 'BADVER', 'value', encKey);

            const data = readVaultFile(freshVault);
            const token = Buffer.from(data.entries.BADVER.value, 'base64');
            token[0] = 0x99;
            data.entries.BADVER.value = token.toString('base64');
            writeVaultFile(freshVault, data);

            const result = secretsVaultGet(freshVault, 'BADVER', encKey);
            expect(result.success).toBe(false);
            expect(result.error).toContain('decryption failed');
        });

        it('should fail when HMAC verification fails', () => {
            const freshVault = path.join(tmpDir, 'bad_hmac.db');
            const encKey = generateSecretsVaultKey();

            secretsVaultSet(freshVault, 'HMAC', 'value', encKey);

            const data = readVaultFile(freshVault);
            const token = Buffer.from(data.entries.HMAC.value, 'base64');
            token[token.length - 1] ^= 0xFF;
            data.entries.HMAC.value = token.toString('base64');
            writeVaultFile(freshVault, data);

            const result = secretsVaultGet(freshVault, 'HMAC', encKey);
            expect(result.success).toBe(false);
            expect(result.error).toContain('decryption failed');
        });
    });

    describe('empty key validation', () => {
        it('should fail when getting with an empty key', () => {
            const encKey = generateSecretsVaultKey();
            const result = secretsVaultGet(vaultPath, '', encKey);
            expect(result.success).toBe(false);
            expect(result.error).toContain('key must not be empty');
        });

        it('should fail when removing with an empty key', () => {
            const result = secretsVaultRemove(vaultPath, '');
            expect(result.success).toBe(false);
            expect(result.error).toContain('key must not be empty');
        });
    });

    describe('tilde path expansion', () => {
        it('should expand bare tilde path to home directory string', () => {
            const fakeHome = path.join(tmpDir, 'bare-tilde-home');
            fs.mkdirSync(fakeHome, { recursive: true });
            const oldHome = process.env.HOME;
            process.env.HOME = fakeHome;
            const encKey = generateSecretsVaultKey();
            try {
                const r = secretsVaultSet('~', 'BARE', 'v', encKey);
                expect(r.success).toBe(false);
                expect(r.error).toBeDefined();
            } finally {
                if (oldHome === undefined) delete process.env.HOME;
                else process.env.HOME = oldHome;
            }
        });

        it('should expand tilde using USERPROFILE when platform is win32', () => {
            const fakeHome = path.join(tmpDir, 'fake-win-home');
            fs.mkdirSync(fakeHome, { recursive: true });
            const oldPlatform = process.platform;
            const oldUserProfile = process.env.USERPROFILE;
            const oldHome = process.env.HOME;
            Object.defineProperty(process, 'platform', { value: 'win32' });
            process.env.USERPROFILE = fakeHome;
            delete process.env.HOME;

            const suffix = Date.now();
            const tildeVault = path.join('~', `.dexalot-win-${suffix}`, 'vault.db');
            const encKey = generateSecretsVaultKey();

            try {
                const result = secretsVaultSet(tildeVault, 'WIN', 'value', encKey);
                expect(result.success).toBe(true);
            } finally {
                Object.defineProperty(process, 'platform', { value: oldPlatform });
                if (oldUserProfile === undefined) {
                    delete process.env.USERPROFILE;
                } else {
                    process.env.USERPROFILE = oldUserProfile;
                }
                if (oldHome === undefined) {
                    delete process.env.HOME;
                } else {
                    process.env.HOME = oldHome;
                }
                const expandedDir = path.join(fakeHome, `.dexalot-win-${suffix}`);
                if (fs.existsSync(expandedDir)) {
                    fs.rmSync(expandedDir, { recursive: true, force: true });
                }
            }
        });

        it('should expand tilde in vault path', () => {
            const fakeHome = path.join(tmpDir, 'fake-home');
            fs.mkdirSync(fakeHome, { recursive: true });
            const oldHome = process.env.HOME;
            const oldUserProfile = process.env.USERPROFILE;
            if (process.platform === 'win32') {
                process.env.USERPROFILE = fakeHome;
            } else {
                process.env.HOME = fakeHome;
            }
            const suffix = Date.now();
            const tildeVault = path.join('~', `.dexalot-test-${suffix}`, 'vault.db');
            const encKey = generateSecretsVaultKey();

            try {
                const result = secretsVaultSet(tildeVault, 'TILDE', 'value', encKey);
                expect(result.success).toBe(true);

                const getResult = secretsVaultGet(tildeVault, 'TILDE', encKey);
                expect(getResult.success).toBe(true);
                expect(getResult.data).toBe('value');
            } finally {
                if (process.platform === 'win32') {
                    if (oldUserProfile === undefined) {
                        delete process.env.USERPROFILE;
                    } else {
                        process.env.USERPROFILE = oldUserProfile;
                    }
                } else if (oldHome === undefined) {
                    delete process.env.HOME;
                } else {
                    process.env.HOME = oldHome;
                }
                const expandedDir = path.join(fakeHome, `.dexalot-test-${suffix}`);
                if (fs.existsSync(expandedDir)) {
                    fs.rmSync(expandedDir, { recursive: true, force: true });
                }
            }
        });
    });

    describe('file format error paths', () => {
        it('should return generic error for non-Fernet vault access errors', () => {
            const dirAsVault = path.join(tmpDir, 'dir_as_vault');
            fs.mkdirSync(dirAsVault, { recursive: true });

            const encKey = generateSecretsVaultKey();
            const result = secretsVaultGet(dirAsVault, 'KEY', encKey);
            expect(result.success).toBe(false);
            expect(result.error).toContain('secretsVaultGet failed');
        });

        it('should return error when vault cannot be listed', () => {
            const dirAsVault = path.join(tmpDir, 'dir_as_vault_list');
            fs.mkdirSync(dirAsVault, { recursive: true });

            const result = secretsVaultList(dirAsVault);
            expect(result.success).toBe(false);
            expect(result.error).toContain('secretsVaultList failed');
        });

        it('should return error when vault cannot be updated', () => {
            const dirAsVault = path.join(tmpDir, 'dir_as_vault_remove');
            fs.mkdirSync(dirAsVault, { recursive: true });

            const result = secretsVaultRemove(dirAsVault, 'KEY');
            expect(result.success).toBe(false);
            expect(result.error).toContain('secretsVaultRemove failed');
        });

        it('should fail when the vault payload is not an object', () => {
            const freshVault = path.join(tmpDir, 'bad_payload.db');
            fs.writeFileSync(freshVault, 'null\n', 'utf8');

            const result = secretsVaultList(freshVault);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Invalid secrets vault file format');
        });

        it('should fail when the vault format marker is unsupported', () => {
            const freshVault = path.join(tmpDir, 'bad_format.db');
            writeVaultFile(freshVault, {
                format: 'something-else',
                version: 1,
                entries: {},
            });

            const result = secretsVaultList(freshVault);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Unsupported secrets vault format');
        });

        it('should fail when the vault version is unsupported', () => {
            const freshVault = path.join(tmpDir, 'bad_version_marker.db');
            writeVaultFile(freshVault, {
                format: 'dexalot-secrets-vault',
                version: 2,
                entries: {},
            });

            const result = secretsVaultList(freshVault);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Unsupported secrets vault version');
        });

        it('should fail when the vault entries payload is invalid', () => {
            const freshVault = path.join(tmpDir, 'bad_entries.db');
            fs.writeFileSync(
                freshVault,
                JSON.stringify({ format: 'dexalot-secrets-vault', version: 1, entries: [] }, null, 2) + '\n',
                'utf8'
            );

            const result = secretsVaultList(freshVault);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Invalid secrets vault file format');
        });

        it('should fail when a vault entry payload is invalid', () => {
            const freshVault = path.join(tmpDir, 'bad_entry.db');
            fs.writeFileSync(
                freshVault,
                JSON.stringify({
                    format: 'dexalot-secrets-vault',
                    version: 1,
                    entries: { BROKEN: { value: 'abc', created_at: 'now' } },
                }, null, 2) + '\n',
                'utf8'
            );

            const result = secretsVaultList(freshVault);
            expect(result.success).toBe(false);
            expect(result.error).toContain("Invalid secrets vault entry for key 'BROKEN'");
        });

        it('should restore owner-only permissions on rewrite', () => {
            const freshVault = path.join(tmpDir, 'permissions_vault.db');
            const encKey = generateSecretsVaultKey();

            expect(secretsVaultSet(freshVault, 'ONE', 'value', encKey).success).toBe(true);
            if (process.platform !== 'win32') {
                fs.chmodSync(freshVault, 0o644);
                expect(secretsVaultSet(freshVault, 'TWO', 'value', encKey).success).toBe(true);
                expect(fs.statSync(freshVault).mode & 0o777).toBe(0o600);
            }
        });

    });
});
