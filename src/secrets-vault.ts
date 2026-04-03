/**
 * Node-only: encrypted file-backed secrets vault.
 * Import from `dexalot-sdk/secrets-vault` — not from the root `dexalot-sdk` package,
 * so browser bundles do not resolve Node filesystem dependencies.
 */
export {
    generateSecretsVaultKey,
    secretsVaultGet,
    secretsVaultList,
    secretsVaultRemove,
    secretsVaultSet,
} from './utils/secretsVault.js';
