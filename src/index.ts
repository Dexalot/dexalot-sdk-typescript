/**
 * Public entry: `DexalotClient`, config factories, `Result`, `MemoryCache`, logging, and version helpers.
 * Node-only secrets vault: `dexalot-sdk/secrets-vault`. For mixins, `Utils`, and types, use `dexalot-sdk/internal`.
 */
import { DexalotClient } from './core/client.js';
import { version } from './version.js';

export { DexalotClient } from './core/client.js';
export type { DexalotConfig } from './core/config.js';
export { createConfig, loadConfigFromEnv } from './core/config.js';
export { MemoryCache } from './utils/cache.js';
export { Result } from './utils/result.js';
export { getLogger } from './utils/observability.js';
export type { Logger } from './utils/observability.js';
export { version };

export function getVersion(): string {
    return version;
}

export default DexalotClient;
