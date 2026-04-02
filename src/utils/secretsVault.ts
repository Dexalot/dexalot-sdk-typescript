/**
 * Encrypted key-value secrets vault backed by SQLite.
 *
 * Uses Fernet symmetric encryption (AES-128-CBC + HMAC-SHA256) in the standard
 * Dexalot operator vault wire format so vault files are portable across tooling.
 *
 * The vault file is created with owner-only permissions (0o600).
 *
 * Typical usage:
 *   const key = generateSecretsVaultKey();
 *   secretsVaultSet('~/.dexalot/secrets_vault.db', 'PRIVATE_KEY', '0x...', key);
 *   const result = secretsVaultGet('~/.dexalot/secrets_vault.db', 'PRIVATE_KEY', key);
 *   if (result.success) {
 *       const privateKey = result.data;
 *   }
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';
import { Result } from './result.js';

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS secrets_vault (
    key        TEXT PRIMARY KEY,
    value      BLOB NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
`;

// ---------- Fernet Implementation ----------
// Fernet spec: https://github.com/fernet/spec/blob/master/Spec.md
// Token format: Version (1 byte) || Timestamp (8 bytes big-endian) || IV (16 bytes) || Ciphertext (AES-128-CBC, PKCS7) || HMAC-SHA256 (32 bytes)
// Key: 32 bytes URL-safe base64 = 16 bytes signing key + 16 bytes encryption key

function fernetEncrypt(plaintext: string, fernetKeyB64: string): Buffer {
    const keyBytes = Buffer.from(fernetKeyB64, 'base64url');
    if (keyBytes.length !== 32) {
        throw new Error(`Fernet key must be 32 bytes, got ${keyBytes.length}`);
    }
    const signingKey = keyBytes.subarray(0, 16);
    const encryptionKey = keyBytes.subarray(16, 32);

    const version = Buffer.from([0x80]);
    const timestamp = Buffer.alloc(8);
    const now = BigInt(Math.floor(Date.now() / 1000));
    timestamp.writeBigUInt64BE(now);

    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-128-cbc', encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);

    // HMAC covers version || timestamp || iv || ciphertext
    const payload = Buffer.concat([version, timestamp, iv, ciphertext]);
    const hmac = crypto.createHmac('sha256', signingKey).update(payload).digest();

    return Buffer.concat([payload, hmac]);
}

function fernetDecrypt(token: Buffer, fernetKeyB64: string): string {
    const keyBytes = Buffer.from(fernetKeyB64, 'base64url');
    if (keyBytes.length !== 32) {
        throw new Error(`Fernet key must be 32 bytes, got ${keyBytes.length}`);
    }
    const signingKey = keyBytes.subarray(0, 16);
    const encryptionKey = keyBytes.subarray(16, 32);

    if (token.length < 57) { // 1 + 8 + 16 + 16(min ciphertext) + 32(hmac) = 73 min, but 57 with empty padding
        throw new Error('Invalid Fernet token: too short');
    }

    const version = token[0];
    if (version !== 0x80) {
        throw new Error(`Invalid Fernet version: ${version}`);
    }

    const hmacProvided = token.subarray(token.length - 32);
    const payload = token.subarray(0, token.length - 32);

    // Verify HMAC
    const hmacComputed = crypto.createHmac('sha256', signingKey).update(payload).digest();
    if (!crypto.timingSafeEqual(hmacProvided, hmacComputed)) {
        throw new Error('Fernet HMAC verification failed');
    }

    const iv = payload.subarray(9, 25); // skip version(1) + timestamp(8)
    const ciphertext = payload.subarray(25);

    const decipher = crypto.createDecipheriv('aes-128-cbc', encryptionKey, iv);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf-8');
}

// ---------- Vault Operations ----------

/** Home directory for tilde expansion: env (like a shell) first, then `os.homedir()`. */
function tildeHomeDir(): string {
    if (process.platform === 'win32') {
        const fromEnv =
            process.env.USERPROFILE ||
            (process.env.HOMEDRIVE && process.env.HOMEPATH
                ? process.env.HOMEDRIVE + process.env.HOMEPATH
                : '');
        if (fromEnv) return fromEnv;
    } else if (process.env.HOME) {
        return process.env.HOME;
    }
    return os.homedir();
}

function expandPath(p: string): string {
    const home = tildeHomeDir();
    if (p === '~') {
        return home;
    }
    if (p.startsWith('~/') || p.startsWith('~\\')) {
        return path.join(home, p.slice(2));
    }
    return path.resolve(p);
}

function openVault(dbPath: string): Database.Database {
    const resolvedPath = expandPath(dbPath);
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const db = new Database(resolvedPath);
    db.exec(CREATE_TABLE);

    // Restrict access to owner only
    try {
        const stat = fs.statSync(resolvedPath);
        if ((stat.mode & 0o777) !== 0o600) {
            fs.chmodSync(resolvedPath, 0o600);
        }
    } catch {
        // Ignore permission errors on some platforms
    }
    return db;
}

/**
 * Generate a new Fernet encryption key.
 * Returns a URL-safe base64-encoded 32-byte key string.
 */
export function generateSecretsVaultKey(): string {
    return crypto.randomBytes(32).toString('base64url');
}

/**
 * Encrypt and store (upsert) a value in the secrets vault.
 */
export function secretsVaultSet(
    dbPath: string, key: string, value: string, encryptionKey: string
): Result<null> {
    if (!key) return Result.fail('secretsVaultSet: key must not be empty');
    if (!value) return Result.fail('secretsVaultSet: value must not be empty');
    try {
        const encrypted = fernetEncrypt(value, encryptionKey);
        const now = new Date().toISOString();
        const db = openVault(dbPath);
        try {
            db.prepare(
                `INSERT OR REPLACE INTO secrets_vault (key, value, created_at, updated_at)
                 VALUES (?, ?, COALESCE(
                 (SELECT created_at FROM secrets_vault WHERE key = ?), ?), ?)`
            ).run(key, encrypted, key, now, now);
        } finally {
            db.close();
        }
        return Result.ok(null);
    } catch (e: any) {
        return Result.fail(`secretsVaultSet failed: ${e.message}`);
    }
}

/**
 * Retrieve and decrypt a value from the secrets vault.
 */
export function secretsVaultGet(
    dbPath: string, key: string, encryptionKey: string
): Result<string> {
    if (!key) return Result.fail('secretsVaultGet: key must not be empty');
    try {
        const db = openVault(dbPath);
        let row: any;
        try {
            row = db.prepare('SELECT value FROM secrets_vault WHERE key = ?').get(key);
        } finally {
            db.close();
        }
        if (!row) {
            return Result.fail(`secretsVaultGet: key '${key}' not found`);
        }
        const plaintext = fernetDecrypt(row.value, encryptionKey);
        return Result.ok(plaintext);
    } catch (e: any) {
        if (e.message?.includes('HMAC') || e.message?.includes('bad decrypt') || e.message?.includes('Fernet')) {
            return Result.fail('secretsVaultGet: decryption failed - wrong key or corrupted data');
        }
        return Result.fail(`secretsVaultGet failed: ${e.message}`);
    }
}

/**
 * List all key names stored in the secrets vault.
 */
export function secretsVaultList(dbPath: string): Result<string[]> {
    try {
        const db = openVault(dbPath);
        let rows: any[];
        try {
            rows = db.prepare('SELECT key FROM secrets_vault ORDER BY key').all();
        } finally {
            db.close();
        }
        return Result.ok(rows.map((r: any) => r.key));
    } catch (e: any) {
        return Result.fail(`secretsVaultList failed: ${e.message}`);
    }
}

/**
 * Remove a key-value pair from the secrets vault.
 */
export function secretsVaultRemove(dbPath: string, key: string): Result<null> {
    if (!key) return Result.fail('secretsVaultRemove: key must not be empty');
    try {
        const db = openVault(dbPath);
        let changes: number;
        try {
            const result = db.prepare('DELETE FROM secrets_vault WHERE key = ?').run(key);
            changes = result.changes;
        } finally {
            db.close();
        }
        if (changes === 0) {
            return Result.fail(`secretsVaultRemove: key '${key}' not found`);
        }
        return Result.ok(null);
    } catch (e: any) {
        return Result.fail(`secretsVaultRemove failed: ${e.message}`);
    }
}
