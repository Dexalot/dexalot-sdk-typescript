/**
 * Implementation of the encrypted-secrets-vault CLI. Exposed as `runCli` and
 * supporting helpers so unit tests can exercise each command without
 * spawning a child process. The user-facing entry point is the
 * `scripts/secrets_vault_cli.mjs` wrapper, which calls `runCli` after a
 * dotenv load.
 *
 * The CLI is glue: it routes argv subcommands to functions in
 * `../secrets-vault` and reads vault path / encryption key from env vars
 * (with an interactive prompt fallback for the key).
 */

import {
    generateSecretsVaultKey,
    secretsVaultGet,
    secretsVaultList,
    secretsVaultRemove,
    secretsVaultSet,
} from '../secrets-vault.js';

const HELP_TEXT = `Manage the Dexalot encrypted secrets vault.

Usage:
  node scripts/secrets_vault_cli.mjs <command> [args]

Commands:
  keygen              Generate and print a new Fernet encryption key.
  add <key> <value>   Encrypt and store (or overwrite) a key-value pair.
  get <key>           Retrieve and decrypt a value.
  list                List all stored key names.
  delete <key>        Remove a key-value pair from the vault.

Environment variables:
  DEXALOT_SECRETS_VAULT_PATH   Path to the vault file
                                (default: ~/.dexalot/secrets_vault.json)
  DEXALOT_SECRETS_VAULT_KEY    Encryption key - if not set, prompted interactively
`;

export function printHelp(): void {
    process.stderr.write(HELP_TEXT);
}

export function resolveVaultPath(env: NodeJS.ProcessEnv = process.env): string {
    return env.DEXALOT_SECRETS_VAULT_PATH || '~/.dexalot/secrets_vault.json';
}

/**
 * Prompt function injected for testability. The production wrapper passes a
 * readline-backed prompter; unit tests pass a stub that returns canned
 * answers (or throws to simulate Ctrl+C / EOF).
 */
export type PromptFn = (question: string) => Promise<string>;

/**
 * Resolve the encryption key, preferring the env var and falling back to an
 * interactive prompt. Returns `null` when the prompt yields an empty value
 * or the prompter throws (Ctrl+C, EOF, etc.) — the caller treats `null` as
 * a fatal abort and exits with code 1.
 */
export async function resolveEncryptionKey(
    env: NodeJS.ProcessEnv = process.env,
    prompt?: PromptFn
): Promise<string | null> {
    const envKey = (env.DEXALOT_SECRETS_VAULT_KEY || '').trim();
    if (envKey) {
        return envKey;
    }
    if (!prompt) {
        // No prompter provided and no env key — treat as abort.
        return null;
    }
    try {
        const key = (await prompt('Enter secrets vault encryption key: ')).trim();
        return key || null;
    } catch {
        return null;
    }
}

export interface RunCliOptions {
    env?: NodeJS.ProcessEnv;
    prompt?: PromptFn;
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
}

function writeLine(stream: NodeJS.WritableStream, line: string): void {
    stream.write(line + '\n');
}

/**
 * Run the CLI with the given argv. Returns the intended exit code. Never
 * calls `process.exit` itself, so tests can drive it directly.
 */
export async function runCli(
    argv: string[],
    opts: RunCliOptions = {}
): Promise<number> {
    const env = opts.env ?? process.env;
    const stdout = opts.stdout ?? process.stdout;
    const stderr = opts.stderr ?? process.stderr;
    const prompt = opts.prompt;

    const [command, ...args] = argv;
    if (!command) {
        stderr.write(HELP_TEXT);
        return 1;
    }

    const vaultPath = resolveVaultPath(env);

    switch (command) {
        case 'keygen': {
            const key = generateSecretsVaultKey();
            writeLine(stdout, key);
            stderr.write(
                '\nStore this key in a safe place (e.g. a password manager).\n' +
                    'Set DEXALOT_SECRETS_VAULT_KEY=<key> before starting the MCP server,\n' +
                    'or enter it when prompted at startup.\n'
            );
            return 0;
        }
        case 'add': {
            const [key, value] = args;
            if (!key || !value) {
                writeLine(stderr, 'Usage: add <key> <value>');
                return 1;
            }
            const encryptionKey = await resolveEncryptionKey(env, prompt);
            if (!encryptionKey) {
                writeLine(stderr, 'Error: encryption key must not be empty.');
                return 1;
            }
            const result = secretsVaultSet(vaultPath, key, value, encryptionKey);
            if (!result.success) {
                writeLine(stderr, `Error: ${result.error}`);
                return 1;
            }
            writeLine(stdout, `Stored '${key}' in ${vaultPath}`);
            return 0;
        }
        case 'get': {
            const [key] = args;
            if (!key) {
                writeLine(stderr, 'Usage: get <key>');
                return 1;
            }
            const encryptionKey = await resolveEncryptionKey(env, prompt);
            if (!encryptionKey) {
                writeLine(stderr, 'Error: encryption key must not be empty.');
                return 1;
            }
            const result = secretsVaultGet(vaultPath, key, encryptionKey);
            if (!result.success) {
                writeLine(stderr, `Error: ${result.error}`);
                return 1;
            }
            writeLine(stdout, result.data as string);
            return 0;
        }
        case 'list': {
            const result = secretsVaultList(vaultPath);
            if (!result.success) {
                writeLine(stderr, `Error: ${result.error}`);
                return 1;
            }
            if (!result.data || result.data.length === 0) {
                writeLine(stdout, `No entries in ${vaultPath}`);
                return 0;
            }
            writeLine(stdout, `Keys stored in ${vaultPath}:`);
            for (const k of result.data) {
                writeLine(stdout, `  ${k}`);
            }
            return 0;
        }
        case 'delete': {
            const [key] = args;
            if (!key) {
                writeLine(stderr, 'Usage: delete <key>');
                return 1;
            }
            const result = secretsVaultRemove(vaultPath, key);
            if (!result.success) {
                writeLine(stderr, `Error: ${result.error}`);
                return 1;
            }
            writeLine(stdout, `Deleted '${key}' from ${vaultPath}`);
            return 0;
        }
        default:
            stderr.write(HELP_TEXT);
            return 1;
    }
}
