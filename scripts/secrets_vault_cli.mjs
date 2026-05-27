#!/usr/bin/env node
import { config as loadDotenv } from 'dotenv';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

loadDotenv();

async function loadCliModule() {
  try {
    return await import('../dist/scripts/secretsVaultCli.js');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      'Error: secrets-vault CLI runtime is not built. Run "npm run build" before using this script.\n' +
        message +
        '\n'
    );
    process.exit(1);
  }
}

async function readlinePrompt(question) {
  const rl = createInterface({ input, output, terminal: true });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

const cli = await loadCliModule();
const exitCode = await cli.runCli(process.argv.slice(2), { prompt: readlinePrompt });
process.exit(exitCode);
