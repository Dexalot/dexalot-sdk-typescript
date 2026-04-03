/**
 * Node-only: encrypted SQLite secrets vault (uses `better-sqlite3`).
 * Import from `dexalot-sdk/secrets-vault` — not from the root `dexalot-sdk` package,
 * so browser bundles do not resolve native SQLite.
 */
export {
    generateSecretsVaultKey,
    secretsVaultGet,
    secretsVaultList,
    secretsVaultRemove,
    secretsVaultSet,
} from './utils/secretsVault.js';
