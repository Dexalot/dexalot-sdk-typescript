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
            // 32 bytes in base64url = 43 chars (no padding)
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
            secretsVaultSet(vaultPath, 'UNICODE', 'hello \u{1F600} world', encKey);
            const result = secretsVaultGet(vaultPath, 'UNICODE', encKey);
            expect(result.success).toBe(true);
            expect(result.data).toBe('hello \u{1F600} world');
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
            const first = secretsVaultGet(freshVault, 'KEY1', encKey);
            expect(first.data).toBe('first');

            secretsVaultSet(freshVault, 'KEY1', 'second', encKey);
            const second = secretsVaultGet(freshVault, 'KEY1', encKey);
            expect(second.data).toBe('second');
        });
    });

    describe('Fernet error paths', () => {
        it('should fail when encrypting with invalid key length (line 43)', () => {
            const shortKey = Buffer.from('tooshort').toString('base64url');
            const result = secretsVaultSet(vaultPath, 'BAD_KEY', 'value', shortKey);
            expect(result.success).toBe(false);
            expect(result.error).toContain('secretsVaultSet failed');
        });

        it('should fail when decrypting with invalid key length (line 67)', () => {
            const freshVault = path.join(tmpDir, 'bad_key_decrypt.db');
            const goodKey = generateSecretsVaultKey();
            secretsVaultSet(freshVault, 'KEY', 'value', goodKey);

            const shortKey = Buffer.from('tooshort').toString('base64url');
            const result = secretsVaultGet(freshVault, 'KEY', shortKey);
            expect(result.success).toBe(false);
            expect(result.error).toContain('decryption failed');
        });

        it('should fail when Fernet token is too short (line 73)', () => {
            // Create a vault with a manually corrupted (truncated) token
            const freshVault = path.join(tmpDir, 'short_token.db');
            const encKey = generateSecretsVaultKey();

            // First set a valid value
            secretsVaultSet(freshVault, 'TRUNC', 'value', encKey);

            // Now directly corrupt the stored token in the database
            const Database = require('better-sqlite3');
            const db = new Database(freshVault);
            const shortToken = Buffer.alloc(10); // Way too short for Fernet
            db.prepare('UPDATE secrets_vault SET value = ? WHERE key = ?').run(shortToken, 'TRUNC');
            db.close();

            const result = secretsVaultGet(freshVault, 'TRUNC', encKey);
            expect(result.success).toBe(false);
            expect(result.error).toContain('decryption failed');
        });

        it('should fail when Fernet version byte is wrong (line 78)', () => {
            const freshVault = path.join(tmpDir, 'bad_version.db');
            const encKey = generateSecretsVaultKey();

            secretsVaultSet(freshVault, 'BADVER', 'value', encKey);

            // Corrupt the version byte (first byte should be 0x80)
            const Database = require('better-sqlite3');
            const db = new Database(freshVault);
            const row = db.prepare('SELECT value FROM secrets_vault WHERE key = ?').get('BADVER');
            const token = Buffer.from(row.value);
            token[0] = 0x99; // Wrong version
            db.prepare('UPDATE secrets_vault SET value = ? WHERE key = ?').run(token, 'BADVER');
            db.close();

            const result = secretsVaultGet(freshVault, 'BADVER', encKey);
            expect(result.success).toBe(false);
            expect(result.error).toContain('decryption failed');
        });

        it('should fail when HMAC verification fails (line 86)', () => {
            const freshVault = path.join(tmpDir, 'bad_hmac.db');
            const encKey = generateSecretsVaultKey();

            secretsVaultSet(freshVault, 'HMAC', 'value', encKey);

            // Corrupt the HMAC (last 32 bytes)
            const Database = require('better-sqlite3');
            const db = new Database(freshVault);
            const row = db.prepare('SELECT value FROM secrets_vault WHERE key = ?').get('HMAC');
            const token = Buffer.from(row.value);
            // Flip a byte in the HMAC section
            token[token.length - 1] ^= 0xFF;
            db.prepare('UPDATE secrets_vault SET value = ? WHERE key = ?').run(token, 'HMAC');
            db.close();

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

    describe('tilde path expansion (line 102)', () => {
        it('should expand tilde in vault path', () => {
            const tildeVault = path.join('~', '.dexalot-test-' + Date.now(), 'vault.db');
            const encKey = generateSecretsVaultKey();

            const result = secretsVaultSet(tildeVault, 'TILDE', 'value', encKey);
            expect(result.success).toBe(true);

            const getResult = secretsVaultGet(tildeVault, 'TILDE', encKey);
            expect(getResult.success).toBe(true);
            expect(getResult.data).toBe('value');

            // Cleanup
            const expandedDir = path.join(os.homedir(), '.dexalot-test-' + tildeVault.split('.dexalot-test-')[1].split('/')[0]);
            if (fs.existsSync(expandedDir)) {
                fs.rmSync(expandedDir, { recursive: true, force: true });
            }
        });
    });

    describe('secretsVaultGet non-Fernet error path (line 187)', () => {
        it('should return generic error for non-Fernet database errors', () => {
            // Use a directory as the "database file" to cause a sqlite error
            const dirAsDb = path.join(tmpDir, 'dir_as_db');
            fs.mkdirSync(dirAsDb, { recursive: true });

            const encKey = generateSecretsVaultKey();
            const result = secretsVaultGet(dirAsDb, 'KEY', encKey);
            expect(result.success).toBe(false);
            expect(result.error).toContain('secretsVaultGet failed');
        });
    });

    describe('secretsVaultList error path (line 205)', () => {
        it('should return error when database cannot be opened', () => {
            // Use a directory as the "database file" to cause a sqlite error
            const dirAsDb = path.join(tmpDir, 'dir_as_db_list');
            fs.mkdirSync(dirAsDb, { recursive: true });

            const result = secretsVaultList(dirAsDb);
            expect(result.success).toBe(false);
            expect(result.error).toContain('secretsVaultList failed');
        });
    });

    describe('secretsVaultRemove error path (line 228)', () => {
        it('should return error when database cannot be opened', () => {
            // Use a directory as the "database file" to cause a sqlite error
            const dirAsDb = path.join(tmpDir, 'dir_as_db_remove');
            fs.mkdirSync(dirAsDb, { recursive: true });

            const result = secretsVaultRemove(dirAsDb, 'KEY');
            expect(result.success).toBe(false);
            expect(result.error).toContain('secretsVaultRemove failed');
        });
    });
});
