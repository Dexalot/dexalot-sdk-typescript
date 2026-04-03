/**
 * Encrypted key-value secrets vault backed by a local file.
 *
 * Uses Fernet symmetric encryption (AES-128-CBC + HMAC-SHA256) in the standard
 * Dexalot operator vault wire format so encrypted values are portable across tooling.
 *
 * The vault file stores a language-neutral JSON document so Python and TypeScript
 * SDKs can share the exact same on-disk format in the future.
 *
 * The vault file is created with owner-only permissions (0o600).
 *
 * Import from `dexalot-sdk/secrets-vault` (Node only). Typical usage:
 *   const key = generateSecretsVaultKey();
 *   secretsVaultSet('~/.dexalot/secrets_vault.json', 'PRIVATE_KEY', '0x...', key);
 *   const result = secretsVaultGet('~/.dexalot/secrets_vault.json', 'PRIVATE_KEY', key);
 *   if (result.success) {
 *       const privateKey = result.data;
 *   }
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Result } from './result.js';

const VAULT_FILE_FORMAT = 'dexalot-secrets-vault';
const VAULT_FILE_VERSION = 1;

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

    if (token.length < 57) {
        throw new Error('Invalid Fernet token: too short');
    }

    const version = token[0];
    if (version !== 0x80) {
        throw new Error(`Invalid Fernet version: ${version}`);
    }

    const hmacProvided = token.subarray(token.length - 32);
    const payload = token.subarray(0, token.length - 32);

    const hmacComputed = crypto.createHmac('sha256', signingKey).update(payload).digest();
    if (!crypto.timingSafeEqual(hmacProvided, hmacComputed)) {
        throw new Error('Fernet HMAC verification failed');
    }

    const iv = payload.subarray(9, 25);
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

function createEmptyVault(): VaultFile {
    return {
        format: VAULT_FILE_FORMAT,
        version: VAULT_FILE_VERSION,
        entries: {},
    };
}

function isVaultEntry(value: unknown): value is VaultEntry {
    if (!value || typeof value !== 'object') return false;
    const entry = value as Record<string, unknown>;
    return typeof entry.value === 'string'
        && typeof entry.created_at === 'string'
        && typeof entry.updated_at === 'string';
}

function parseVaultFile(raw: string): VaultFile {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('Invalid secrets vault file format');
    }
    const record = parsed as Record<string, unknown>;
    if (record.format !== VAULT_FILE_FORMAT) {
        throw new Error(`Unsupported secrets vault format: ${String(record.format)}`);
    }
    if (record.version !== VAULT_FILE_VERSION) {
        throw new Error(`Unsupported secrets vault version: ${String(record.version)}`);
    }
    if (!record.entries || typeof record.entries !== 'object' || Array.isArray(record.entries)) {
        throw new Error('Invalid secrets vault file format');
    }

    const entries: Record<string, VaultEntry> = {};
    for (const [key, value] of Object.entries(record.entries as Record<string, unknown>)) {
        if (!isVaultEntry(value)) {
            throw new Error(`Invalid secrets vault entry for key '${key}'`);
        }
        entries[key] = value;
    }

    return {
        format: VAULT_FILE_FORMAT,
        version: VAULT_FILE_VERSION,
        entries,
    };
}

function writeVaultFile(resolvedPath: string, data: VaultFile): void {
    const payload = JSON.stringify(data, null, 2) + '\n';
    const tmpPath = `${resolvedPath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, resolvedPath);

    try {
        fs.chmodSync(resolvedPath, 0o600);
    } catch {
        // Ignore permission errors on some platforms
    }
}

function ensureVaultPath(vaultPath: string): string {
    const resolvedPath = expandPath(vaultPath);
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    if (fs.existsSync(resolvedPath)) {
        if (fs.statSync(resolvedPath).isDirectory()) {
            throw new Error('vault path is a directory');
        }
        return resolvedPath;
    }

    writeVaultFile(resolvedPath, createEmptyVault());
    return resolvedPath;
}

function loadVault(vaultPath: string): { resolvedPath: string; data: VaultFile } {
    const resolvedPath = ensureVaultPath(vaultPath);
    const raw = fs.readFileSync(resolvedPath, 'utf8');
    return {
        resolvedPath,
        data: parseVaultFile(raw),
    };
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
    vaultPath: string, key: string, value: string, encryptionKey: string
): Result<null> {
    if (!key) return Result.fail('secretsVaultSet: key must not be empty');
    if (!value) return Result.fail('secretsVaultSet: value must not be empty');
    try {
        const encrypted = fernetEncrypt(value, encryptionKey).toString('base64');
        const now = new Date().toISOString();
        const { resolvedPath, data } = loadVault(vaultPath);
        const existing = data.entries[key];
        data.entries[key] = {
            value: encrypted,
            created_at: existing?.created_at ?? now,
            updated_at: now,
        };
        writeVaultFile(resolvedPath, data);
        return Result.ok(null);
    } catch (e: any) {
        return Result.fail(`secretsVaultSet failed: ${e.message}`);
    }
}

/**
 * Retrieve and decrypt a value from the secrets vault.
 */
export function secretsVaultGet(
    vaultPath: string, key: string, encryptionKey: string
): Result<string> {
    if (!key) return Result.fail('secretsVaultGet: key must not be empty');
    try {
        const { data } = loadVault(vaultPath);
        const entry = data.entries[key];
        if (!entry) {
            return Result.fail(`secretsVaultGet: key '${key}' not found`);
        }
        const plaintext = fernetDecrypt(Buffer.from(entry.value, 'base64'), encryptionKey);
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
export function secretsVaultList(vaultPath: string): Result<string[]> {
    try {
        const { data } = loadVault(vaultPath);
        return Result.ok(Object.keys(data.entries).sort());
    } catch (e: any) {
        return Result.fail(`secretsVaultList failed: ${e.message}`);
    }
}

/**
 * Remove a key-value pair from the secrets vault.
 */
export function secretsVaultRemove(vaultPath: string, key: string): Result<null> {
    if (!key) return Result.fail('secretsVaultRemove: key must not be empty');
    try {
        const { resolvedPath, data } = loadVault(vaultPath);
        if (!data.entries[key]) {
            return Result.fail(`secretsVaultRemove: key '${key}' not found`);
        }
        delete data.entries[key];
        writeVaultFile(resolvedPath, data);
        return Result.ok(null);
    } catch (e: any) {
        return Result.fail(`secretsVaultRemove failed: ${e.message}`);
    }
}
