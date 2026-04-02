/**
 * Public entry: `DexalotClient`, config factories, `Result`, `MemoryCache`, secrets vault, and version helpers.
 * For mixins, `Utils`, and types, import from `dexalot-sdk/internal`.
 */
import { DexalotClient } from './core/client.js';
import { version } from './version.js';

export { DexalotClient } from './core/client.js';
export type { DexalotConfig } from './core/config.js';
export { createConfig, loadConfigFromEnv } from './core/config.js';
export { MemoryCache } from './utils/cache.js';
export { Result } from './utils/result.js';
export {
    generateSecretsVaultKey,
    secretsVaultGet,
    secretsVaultList,
    secretsVaultRemove,
    secretsVaultSet,
} from './utils/secretsVault.js';
export { version };

export function getVersion(): string {
    return version;
}

export default DexalotClient;
