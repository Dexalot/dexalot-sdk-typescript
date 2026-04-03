#!/usr/bin/env node
import { config as loadDotenv } from 'dotenv';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output, stderr } from 'node:process';

loadDotenv();

async function loadSecretsVaultModule() {
  try {
    return await import('../dist/secrets-vault.js');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      'Error: secrets vault runtime is not built. Run "npm run build" before using this script.\n' + message,
      { file: stderr }
    );
    process.exit(1);
  }
}

function resolveVaultPath() {
  return process.env.DEXALOT_SECRETS_VAULT_PATH || '~/.dexalot/secrets_vault.json';
}

async function resolveEncryptionKey() {
  const envKey = (process.env.DEXALOT_SECRETS_VAULT_KEY || '').trim();
  if (envKey) {
    return envKey;
  }

  const rl = createInterface({ input, output, terminal: true });
  try {
    const key = (await rl.question('Enter secrets vault encryption key: ')).trim();
    if (!key) {
      console.error('Error: encryption key must not be empty.');
      process.exit(1);
    }
    return key;
  } finally {
    rl.close();
  }
}

function printHelp() {
  console.error(`Manage the Dexalot encrypted secrets vault.

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
`);
}

async function main(argv) {
  const [command, ...args] = argv;
  if (!command) {
    printHelp();
    return 1;
  }

  const mod = await loadSecretsVaultModule();
  const vaultPath = resolveVaultPath();

  switch (command) {
    case 'keygen': {
      const key = mod.generateSecretsVaultKey();
      console.log(key);
      console.error(
        '\nStore this key in a safe place (e.g. a password manager).\n' +
          'Set DEXALOT_SECRETS_VAULT_KEY=<key> before starting the MCP server,\n' +
          'or enter it when prompted at startup.'
      );
      return 0;
    }
    case 'add': {
      const [key, value] = args;
      if (!key || !value) {
        console.error('Usage: add <key> <value>');
        return 1;
      }
      const encryptionKey = await resolveEncryptionKey();
      const result = mod.secretsVaultSet(vaultPath, key, value, encryptionKey);
      if (!result.success) {
        console.error(`Error: ${result.error}`);
        return 1;
      }
      console.log(`Stored '${key}' in ${vaultPath}`);
      return 0;
    }
    case 'get': {
      const [key] = args;
      if (!key) {
        console.error('Usage: get <key>');
        return 1;
      }
      const encryptionKey = await resolveEncryptionKey();
      const result = mod.secretsVaultGet(vaultPath, key, encryptionKey);
      if (!result.success) {
        console.error(`Error: ${result.error}`);
        return 1;
      }
      console.log(result.data);
      return 0;
    }
    case 'list': {
      const result = mod.secretsVaultList(vaultPath);
      if (!result.success) {
        console.error(`Error: ${result.error}`);
        return 1;
      }
      if (!result.data || result.data.length === 0) {
        console.log(`No entries in ${vaultPath}`);
        return 0;
      }
      console.log(`Keys stored in ${vaultPath}:`);
      for (const key of result.data) {
        console.log(`  ${key}`);
      }
      return 0;
    }
    case 'delete': {
      const [key] = args;
      if (!key) {
        console.error('Usage: delete <key>');
        return 1;
      }
      const result = mod.secretsVaultRemove(vaultPath, key);
      if (!result.success) {
        console.error(`Error: ${result.error}`);
        return 1;
      }
      console.log(`Deleted '${key}' from ${vaultPath}`);
      return 0;
    }
    default:
      printHelp();
      return 1;
  }
}

const exitCode = await main(process.argv.slice(2));
process.exit(exitCode);
