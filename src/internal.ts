/**
 * Full SDK surface: clients, mixins, types, constants, and utilities.
 * Use the root `dexalot-sdk` package for the supported application-facing API.
 */
export * from './core/client.js';
export * from './core/base.js';
export * from './core/clob.js';
export * from './core/swap.js';
export * from './core/transfer.js';
export * from './core/config.js';
export * from './types/index.js';
export * from './constants.js';
export * from './utils/index.js';
export { version } from './version.js';

import { DexalotClient } from './core/client.js';
export default DexalotClient;
