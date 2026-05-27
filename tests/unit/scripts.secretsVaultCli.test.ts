/**
 * Tests for the secrets-vault CLI runner shipped at
 * `src/scripts/secretsVaultCli.ts`. The runner is thin glue that routes
 * argv subcommands to functions in `src/secrets-vault.ts` and reads its
 * vault path / encryption key from env vars (with a prompt fallback).
 *
 * Tests below exercise each command end-to-end against a real on-disk
 * vault (using a freshly generated key) and spot-check error paths with
 * stubbed dependencies.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import {
    printHelp,
    resolveEncryptionKey,
    resolveVaultPath,
    runCli,
} from '../../src/scripts/secretsVaultCli';
import { generateSecretsVaultKey } from '../../src/secrets-vault';

function captureStream(): { stream: Writable; output: string[] } {
    const output: string[] = [];
    const stream = new Writable({
        write(chunk, _enc, cb) {
            output.push(chunk.toString());
            cb();
        },
    });
    return { stream, output };
}

function captures() {
    const out = captureStream();
    const err = captureStream();
    return {
        stdout: out.stream,
        stderr: err.stream,
        outText: () => out.output.join(''),
        errText: () => err.output.join(''),
    };
}

describe('resolveVaultPath', () => {
    it('uses DEXALOT_SECRETS_VAULT_PATH when present', () => {
        expect(resolveVaultPath({ DEXALOT_SECRETS_VAULT_PATH: '/tmp/custom.json' })).toBe(
            '/tmp/custom.json'
        );
    });

    it('falls back to ~/.dexalot/secrets_vault.json when env is absent', () => {
        expect(resolveVaultPath({})).toBe('~/.dexalot/secrets_vault.json');
    });

    it('uses process.env by default when no env arg is passed', () => {
        // Default-arg branch coverage: we don't want to depend on the
        // ambient env in this test, only on the parameter default firing.
        const restore = process.env.DEXALOT_SECRETS_VAULT_PATH;
        process.env.DEXALOT_SECRETS_VAULT_PATH = '/tmp/default-arg.json';
        try {
            expect(resolveVaultPath()).toBe('/tmp/default-arg.json');
        } finally {
            if (restore === undefined) delete process.env.DEXALOT_SECRETS_VAULT_PATH;
            else process.env.DEXALOT_SECRETS_VAULT_PATH = restore;
        }
    });
});

describe('resolveEncryptionKey', () => {
    it('returns the env key when DEXALOT_SECRETS_VAULT_KEY is set', async () => {
        const key = await resolveEncryptionKey({ DEXALOT_SECRETS_VAULT_KEY: 'from-env' });
        expect(key).toBe('from-env');
    });

    it('trims whitespace around the env key', async () => {
        const key = await resolveEncryptionKey({ DEXALOT_SECRETS_VAULT_KEY: '   spaced   ' });
        expect(key).toBe('spaced');
    });

    it('treats whitespace-only env keys as empty and falls through to prompt', async () => {
        const key = await resolveEncryptionKey(
            { DEXALOT_SECRETS_VAULT_KEY: '   ' },
            async () => 'prompted-key'
        );
        expect(key).toBe('prompted-key');
    });

    it('prompts when env key is absent', async () => {
        const key = await resolveEncryptionKey({}, async () => 'prompted-key');
        expect(key).toBe('prompted-key');
    });

    it('returns null when prompter yields an empty string', async () => {
        const key = await resolveEncryptionKey({}, async () => '   ');
        expect(key).toBeNull();
    });

    it('returns null when prompter throws (Ctrl+C / EOF)', async () => {
        const key = await resolveEncryptionKey({}, async () => {
            throw new Error('cancelled');
        });
        expect(key).toBeNull();
    });

    it('returns null when no env key AND no prompter provided', async () => {
        const key = await resolveEncryptionKey({});
        expect(key).toBeNull();
    });

    it('uses process.env by default when no env arg is passed', async () => {
        const restore = process.env.DEXALOT_SECRETS_VAULT_KEY;
        process.env.DEXALOT_SECRETS_VAULT_KEY = 'default-arg-key';
        try {
            const key = await resolveEncryptionKey();
            expect(key).toBe('default-arg-key');
        } finally {
            if (restore === undefined) delete process.env.DEXALOT_SECRETS_VAULT_KEY;
            else process.env.DEXALOT_SECRETS_VAULT_KEY = restore;
        }
    });
});

describe('printHelp', () => {
    it('writes the usage banner to stderr', () => {
        const spy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
            printHelp();
            const call = spy.mock.calls[0][0];
            expect(String(call)).toContain('Usage:');
            expect(String(call)).toContain('keygen');
            expect(String(call)).toContain('DEXALOT_SECRETS_VAULT_KEY');
        } finally {
            spy.mockRestore();
        }
    });
});

describe('runCli — round-trip on a real on-disk vault', () => {
    let vaultDir: string;
    let vaultPath: string;
    let key: string;
    let env: NodeJS.ProcessEnv;

    beforeEach(() => {
        vaultDir = mkdtempSync(join(tmpdir(), 'dexalot-cli-test-'));
        vaultPath = join(vaultDir, 'vault.json');
        key = generateSecretsVaultKey();
        env = {
            DEXALOT_SECRETS_VAULT_PATH: vaultPath,
            DEXALOT_SECRETS_VAULT_KEY: key,
        };
    });

    afterEach(() => {
        rmSync(vaultDir, { recursive: true, force: true });
    });

    it('add → get → list → delete round trip', async () => {
        const c1 = captures();
        expect(await runCli(['add', 'API_KEY', 's3cret-value'], { env, ...c1 })).toBe(0);
        expect(c1.outText()).toContain("Stored 'API_KEY'");

        const c2 = captures();
        expect(await runCli(['get', 'API_KEY'], { env, ...c2 })).toBe(0);
        expect(c2.outText()).toContain('s3cret-value');

        const c3 = captures();
        expect(await runCli(['list'], { env, ...c3 })).toBe(0);
        expect(c3.outText()).toContain('API_KEY');
        expect(c3.outText()).toContain(vaultPath);

        const c4 = captures();
        expect(await runCli(['delete', 'API_KEY'], { env, ...c4 })).toBe(0);
        expect(c4.outText()).toContain("Deleted 'API_KEY'");
    });

    it('list on an empty vault emits a "No entries" message', async () => {
        const c = captures();
        expect(await runCli(['list'], { env, ...c })).toBe(0);
        expect(c.outText()).toContain('No entries');
    });
});

describe('runCli — command parsing and error paths', () => {
    let env: NodeJS.ProcessEnv;

    beforeEach(() => {
        env = {
            DEXALOT_SECRETS_VAULT_PATH: '/dev/null/nonexistent-path',
            DEXALOT_SECRETS_VAULT_KEY: 'unused',
        };
    });

    it('keygen prints a fresh key to stdout plus safety guidance to stderr', async () => {
        const c = captures();
        expect(await runCli(['keygen'], { env, ...c })).toBe(0);
        expect(c.outText().trim()).toBeTruthy();
        expect(c.errText()).toContain('Store this key');
    });

    it('returns 1 and prints help when invoked with no command', async () => {
        const c = captures();
        expect(await runCli([], { env, ...c })).toBe(1);
        expect(c.errText()).toContain('Usage:');
    });

    it('returns 1 and prints help on an unknown command', async () => {
        const c = captures();
        expect(await runCli(['banana'], { env, ...c })).toBe(1);
        expect(c.errText()).toContain('Usage:');
    });

    it('add returns 1 when key is missing', async () => {
        const c = captures();
        expect(await runCli(['add'], { env, ...c })).toBe(1);
        expect(c.errText()).toContain('Usage: add');
    });

    it('add returns 1 when value is missing', async () => {
        const c = captures();
        expect(await runCli(['add', 'K'], { env, ...c })).toBe(1);
        expect(c.errText()).toContain('Usage: add');
    });

    it('add returns 1 when no encryption key is resolvable', async () => {
        const c = captures();
        const code = await runCli(['add', 'K', 'V'], {
            env: { DEXALOT_SECRETS_VAULT_PATH: '/tmp/x.json' },
            ...c,
        });
        expect(code).toBe(1);
        expect(c.errText()).toContain('encryption key must not be empty');
    });

    it('add returns 1 when the vault library fails', async () => {
        // Garbage path causes secretsVaultSet to fail at write time.
        const c = captures();
        const code = await runCli(['add', 'K', 'V'], {
            env: {
                DEXALOT_SECRETS_VAULT_PATH: '\0/invalid',
                DEXALOT_SECRETS_VAULT_KEY: generateSecretsVaultKey(),
            },
            ...c,
        });
        expect(code).toBe(1);
        expect(c.errText()).toContain('Error:');
    });

    it('get returns 1 when key is missing', async () => {
        const c = captures();
        expect(await runCli(['get'], { env, ...c })).toBe(1);
        expect(c.errText()).toContain('Usage: get');
    });

    it('get returns 1 when no encryption key is resolvable', async () => {
        const c = captures();
        const code = await runCli(['get', 'K'], {
            env: { DEXALOT_SECRETS_VAULT_PATH: '/tmp/x.json' },
            ...c,
        });
        expect(code).toBe(1);
        expect(c.errText()).toContain('encryption key must not be empty');
    });

    it('get returns 1 when the vault library fails', async () => {
        const c = captures();
        const code = await runCli(['get', 'MISSING'], {
            env: {
                DEXALOT_SECRETS_VAULT_PATH: '/dev/null/nonexistent',
                DEXALOT_SECRETS_VAULT_KEY: generateSecretsVaultKey(),
            },
            ...c,
        });
        expect(code).toBe(1);
        expect(c.errText()).toContain('Error:');
    });

    it('list returns 1 when the vault library fails', async () => {
        const c = captures();
        // Use a path that exists as a directory — secretsVaultList will try
        // to read it as a file and fail.
        const code = await runCli(['list'], {
            env: { DEXALOT_SECRETS_VAULT_PATH: tmpdir() },
            ...c,
        });
        expect(code).toBe(1);
        expect(c.errText()).toContain('Error:');
    });

    it('delete returns 1 when key is missing', async () => {
        const c = captures();
        expect(await runCli(['delete'], { env, ...c })).toBe(1);
        expect(c.errText()).toContain('Usage: delete');
    });

    it('delete returns 1 when the vault library fails', async () => {
        const c = captures();
        const code = await runCli(['delete', 'MISSING'], {
            env: { DEXALOT_SECRETS_VAULT_PATH: '/dev/null/nonexistent' },
            ...c,
        });
        expect(code).toBe(1);
        expect(c.errText()).toContain('Error:');
    });

    it('defaults stdout/stderr/env to process.* when opts are absent', async () => {
        // Drive the default-branch for opts.stdout / opts.stderr / opts.env.
        // We spy on process.stderr.write so this doesn't pollute test output.
        const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
            expect(await runCli([])).toBe(1);
            expect(stderrSpy).toHaveBeenCalled();
        } finally {
            stderrSpy.mockRestore();
        }
    });
});
