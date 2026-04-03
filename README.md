# Dexalot TypeScript SDK

## Overview

`dexalot-sdk` is a TypeScript/JavaScript library that provides core functionality for interacting with the Dexalot decentralized exchange. It offers a unified client interface for trading operations, cross-chain transfers, and portfolio management across multiple blockchain networks.

## Features

- **Unified Client**: Single `DexalotClient` interface for all Dexalot operations
- **Modular Architecture**: Functional mixins for CLOB, Swap, and Transfer operations
- **Multi-Chain Support**: Works with Dexalot L1 subnet and connected mainnet networks
- **Type Safety**: Full TypeScript support with comprehensive type definitions
- **Caching**: TTL-based memory cache utilities for performance optimization

## Architecture

### Core Components

- **`core/client.ts`**: Unified `DexalotClient` composed from modular mixins
- **`core/base.ts`**: Environment setup, Web3 connections, error handling
- **`core/clob.ts`**: Central Limit Order Book trading operations
- **`core/swap.ts`**: SimpleSwap RFQ (Request for Quote) functionality
- **`core/transfer.ts`**: Cross-chain deposits/withdrawals, portfolio management

### Utilities

- **`utils/input_validators.ts`**: Validate SDK method input parameters (amounts, addresses, pairs, etc.)
- **`utils/cache.ts`**: TTL-based caching utilities (`MemoryCache`, `withCache`, `withInstanceCache`)
- **`utils/observability.ts`**: Structured logging and operation tracking
- **`utils/result.ts`**: Standardized `Result<T>` type for consistent error handling
- **`utils/retry.ts`**: Async retry decorator with exponential backoff
- **`utils/rateLimit.ts`**: Token bucket rate limiter for API and RPC calls
- **`utils/nonceManager.ts`**: Thread-safe nonce management to prevent transaction race conditions
- **`utils/providerManager.ts`**: RPC provider failover with health tracking
- **`utils/errorSanitizer.ts`**: Error message sanitization to prevent information leakage
- **`utils/websocketManager.ts`**: Persistent WebSocket connection manager with reconnection and heartbeat

## Installation

Install the SDK using pnpm (recommended):

```sh
pnpm add dexalot-sdk
```

Or use alternative package managers:

```sh
# npm
npm install dexalot-sdk

# yarn
yarn add dexalot-sdk
```

Or install from the repository:

```sh
cd typescript/dexalot-sdk
pnpm install
pnpm run build
```

## Package exports

- **`dexalot-sdk`**: Default export `DexalotClient`, plus `DexalotConfig` (type), `createConfig`, `loadConfigFromEnv`, `MemoryCache`, `Result`, `getLogger` / `Logger`, `version`, and `getVersion()`.
- **`dexalot-sdk/secrets-vault`**: `generateSecretsVaultKey`, `secretsVaultGet` / `Set` / `List` / `Remove`.
- **`dexalot-sdk/internal`**: `BaseClient`, `CLOBClient`, `SwapClient`, `TransferClient`, `Utils`, types, constants, and the rest of the implementation surface for advanced use (excludes the secrets vault; use the subpath above).

Call `await client.initializeClient()` before trading RPC/API usage, optionally `await client.connect()`, and `await client.close()` when tearing down. Successful on-chain `Result` payloads use camelCase fields such as `txHash`, `operation`, and batch id lists where applicable.

## Secrets Vault

The Node-only secrets vault is exported from `dexalot-sdk/secrets-vault`. It stores encrypted values in a local Fernet-encrypted JSON file using the shared Dexalot vault format, so Python and TypeScript tooling can read the same vault file.

Default path:

```sh
~/.dexalot/secrets_vault.json
```

Environment variables:

```sh
DEXALOT_SECRETS_VAULT_KEY=<your-fernet-key>
DEXALOT_SECRETS_VAULT_PATH=~/.dexalot/secrets_vault.json
```

Example:

```typescript
import {
    generateSecretsVaultKey,
    secretsVaultSet,
    secretsVaultGet,
} from "dexalot-sdk/secrets-vault";

const key = generateSecretsVaultKey();
secretsVaultSet("~/.dexalot/secrets_vault.json", "PRIVATE_KEY", "0x...", key);
const result = secretsVaultGet("~/.dexalot/secrets_vault.json", "PRIVATE_KEY", key);
```

A CLI helper is also available:

```sh
npm run secrets-vault -- keygen
npm run secrets-vault -- add PRIVATE_KEY 0xabc123...
```

## Quick Start

```typescript
import DexalotClient from 'dexalot-sdk';

async function main() {
    let client: DexalotClient | null = null;
    try {
        // Initialize client
        client = new DexalotClient();
        const result = await client.initializeClient();
        
        if (!result.success) {
            console.error(`Initialization failed: ${result.error}`);
            return;
        }
        
        // Fetch trading pairs (stores pairs in client.pairs)
        const pairsResult = await client.getClobPairs();
        if (pairsResult.success) {
            console.log(`Available pairs: ${Object.keys(client.pairs)}`);
        } else {
            console.error(`Error: ${pairsResult.error}`);
        }
    } finally {
        // Always close the client to clean up resources
        if (client !== null) {
            await client.close();
        }
    }
}

// Run the async function
main().catch(console.error);
```

**Key Points:**
- The SDK is **fully async** - all methods must be awaited
- All methods return `Result<T>` for consistent error handling
- Use `async/await` for async contexts
- Always call `await client.close()` when done to clean up resources

## Usage

### Basic Async Usage

```typescript
import DexalotClient from 'dexalot-sdk';

async function main() {
    let client: DexalotClient | null = null;
    try {
        client = new DexalotClient();
        
        // Initialize client (required before other operations)
        const initResult = await client.initializeClient();
        if (!initResult.success) {
            console.error(`Failed to initialize: ${initResult.error}`);
            return;
        }
        
        // Get available trading pairs (stores pairs in client.pairs)
        const pairsResult = await client.getClobPairs();
        if (pairsResult.success) {
            console.log(`Found ${Object.keys(client.pairs).length} trading pairs`);
        } else {
            console.error(`Error fetching pairs: ${pairsResult.error}`);
        }
    } finally {
        // Always close the client to clean up resources
        if (client !== null) {
            await client.close();
        }
    }
}

main().catch(console.error);
```

### Error Handling with Result Pattern

All SDK methods return `Result<T>` which provides consistent error handling:

```typescript
const result = await client.getOrderBook("AVAX/USDC");

if (result.success) {
    const orderbook = result.data;
    console.log(`Bids: ${orderbook.bids}`);
    console.log(`Asks: ${orderbook.asks}`);
} else {
    console.error(`Error: ${result.error}`);
    // Handle error appropriately
}
```

## Dependencies

- `ethers>=6.0.0`: Multi-chain blockchain interactions
- `axios`: HTTP client for Dexalot API communication
- `dotenv`: Environment variable management

## Testing

Run tests from the package directory:

```sh
pnpm test          # Unit tests
pnpm test:unit     # Unit tests only
pnpm test:int      # Integration tests
```

## Caching

The SDK includes a built-in 4-level caching system to optimize performance by reducing redundant API calls. Caching is **enabled by default** with sensible TTL (Time-To-Live) values.

> **📖 Detailed Documentation**: See [SDK Caching Guide](../../docs/sdk-caching.md) for comprehensive caching documentation, including advanced usage patterns, use cases, troubleshooting, and performance considerations.

### Cache Levels

| Level | Data Type | Default TTL | Examples |
|-------|-----------|-------------|----------|
| **Static** | Rarely changes | 1 hour | Environments, deployments, mainnets |
| **Semi-Static** | Changes occasionally | 15 minutes | Tokens, trading pairs |
| **Balance** | User-specific, updates frequently | 10 seconds | Portfolio balances, wallet balances |
| **Orderbook** | Real-time data | 1 second | Order book snapshots |

### Basic Usage

```typescript
import DexalotClient from 'dexalot-sdk';

// Caching is enabled by default
const client = new DexalotClient();
await client.initializeClient();

// First call fetches from API
const balances = await client.getAllPortfolioBalances();
console.log(balances);
// { ALOT: { available: 95.5, locked: 4.5, total: 100.0 }, AVAX: ... }

// Second call within 10 seconds returns cached result
const cachedBalances = await client.getAllPortfolioBalances(); // Cached!
```

### Configuration

Customize cache behavior during client initialization:

```typescript
import DexalotClient, { createConfig } from 'dexalot-sdk';

// Disable caching entirely
const clientNoCache = new DexalotClient(createConfig({ cacheEnabled: false }));

// Custom TTL values (in seconds)
const clientCustomCache = new DexalotClient(createConfig({
    cacheEnabled: true,
    cacheTtlStatic: 7200,      // 2 hours for static data
    cacheTtlSemiStatic: 1800,  // 30 minutes for semi-static
    cacheTtlBalance: 5,         // 5 seconds for balances
    cacheTtlOrderbook: 0.5     // 500ms for orderbook
}));
```

### Cache Invalidation

Manually clear cached data when needed:

```typescript
// Clear all cache levels
client.invalidateCache();

// Clear specific cache level
client.invalidateCache('balance'); // Options: 'static', 'semi_static', 'balance', 'orderbook', 'all'
```

### Cached Methods

**Static Data (1 hour):**
- `getEnvironments()`
- `getChains()`
- `getDeployment()`

**Semi-Static Data (15 minutes):**
- `getTokens()`
- `getClobPairs()`
- `getSwapPairs(chainId)`

**Balance Data (10 seconds):**
- `getPortfolioBalance(token, address?)`
- `getAllPortfolioBalances(address?)`
- `getChainWalletBalance(chain, token, address?)`
- `getChainWalletBalances(chain, address?)`
- `getAllChainWalletBalances(address?)`

**Orderbook Data (1 second):**
- `getOrderBook(pair)`

**Note:** Write operations (e.g., `addOrder()`, `cancelOrder()`, `deposit()`, `withdraw()`) are **never cached** to ensure data integrity.

### Per-User Caching

Balance data is cached per user address. When `address` is not provided, the SDK uses the connected wallet's address:

```typescript
// Each user gets their own cached balance data
const balance1 = await client.getPortfolioBalance("USDC"); // Uses connected wallet
const balance2 = await client.getPortfolioBalance("USDC", "0xOtherUser"); // Different cache entry
```

### Performance Impact

Expected reduction in API calls:
- **Static data**: ~99.9% fewer calls (1 call per hour vs. every request)
- **Semi-static data**: ~95% fewer calls (1 call per 15 min vs. frequent polling)
- **Balance data**: Significant reduction for applications polling balances
- **Orderbook data**: Useful for multi-component applications

## Configuration

The SDK uses a centralized configuration system (`DexalotConfig`) that supports multiple initialization methods.

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `parentEnv` | `string` | `"fuji-multi"` | Environment configuration (e.g., `production-multi-avax`, `fuji-multi`) |
| `apiBaseUrl` | `string` | Auto-detected | Base URL for Dexalot API (derived from `parentEnv`) |
| `privateKey` | `string` | `undefined` | Wallet private key for signing transactions |
| `cacheEnabled` | `boolean` | `true` | Enable/disable all caching behavior |
| `timeoutConnect` | `number` | `5` | Connect timeout in seconds (env parity with Python; axios uses read timeout as the request cap) |
| `timeoutRead` | `number` | `30` | Read timeout in seconds (axios request timeout = this value × 1000 ms) |
| `logLevel` | `string` | `"info"` | Logging verbosity (`debug`, `info`, `warn`, `error`) |
| `logFormat` | `string` | `"console"` | Log output format (`console`, `json`) |
| `connectionPoolLimit` | `number` | `100` | Total connection pool size across all hosts |
| `connectionPoolLimitPerHost` | `number` | `30` | Maximum connections per individual host |

### Retry Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `retryEnabled` | `boolean` | `true` | Enable/disable automatic retry |
| `retryMaxAttempts` | `number` | `3` | Maximum number of retry attempts |
| `retryInitialDelay` | `number` | `1` | Initial delay in seconds before first retry |
| `retryMaxDelay` | `number` | `10` | Maximum delay in seconds between retries |
| `retryExponentialBase` | `number` | `2.0` | Exponential backoff multiplier |
| `retryOnStatus` | `number[]` | `[429, 500, 502, 503, 504]` | HTTP status codes that trigger retry |

### Rate Limiting Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `rateLimitEnabled` | `boolean` | `true` | Enable/disable rate limiting |
| `rateLimitRequestsPerSecond` | `number` | `5.0` | Maximum API requests per second |
| `rateLimitRpcPerSecond` | `number` | `10.0` | Maximum RPC calls per second |

### Nonce Manager Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `nonceManagerEnabled` | `boolean` | `true` | Enable/disable nonce manager (prevents race conditions) |

### WebSocket Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `wsManagerEnabled` | `boolean` | `false` | Enable/disable WebSocket Manager (persistent connections) |
| `wsPingInterval` | `number` | `30` | Seconds between ping messages |
| `wsPingTimeout` | `number` | `10` | Seconds to wait for pong before reconnecting |
| `wsReconnectInitialDelay` | `number` | `1` | Initial reconnect delay in seconds |
| `wsReconnectMaxDelay` | `number` | `60` | Maximum reconnect delay in seconds |
| `wsReconnectExponentialBase` | `number` | `2.0` | Exponential backoff multiplier |
| `wsReconnectMaxAttempts` | `number` | `10` | Maximum reconnection attempts (0 = infinite) |

### Precedence

Configuration values are resolved in the following order (highest to lowest priority):

1. **Constructor Arguments**: Passed directly to `DexalotClient`
   ```typescript
   // 1. Highest Priority
   const client = new DexalotClient(createConfig({ parentEnv: "custom-env" }));
   ```

2. **Environment Variables**: System-level variables
   ```bash
   # 2. High Priority
   export DEXALOT_PARENT_ENV="production-multi-avax"
   ```

3. **`.env` File**: Variables loaded from local `.env` file
   ```ini
   # 3. Medium Priority
   DEXALOT_PARENT_ENV=fuji-multi
   ```

4. **Defaults**: Hardcoded SDK defaults (`fuji-multi`)

### Advanced Configuration

For complex setups, you can pass a `DexalotConfig` object directly:

```typescript
import DexalotClient, { createConfig } from 'dexalot-sdk';

const config = createConfig({
    parentEnv: "production-multi-subnet",
    timeoutConnect: 10,
    timeoutRead: 60,
    cacheEnabled: false
});

const client = new DexalotClient(config);
```

See `env.example` for all available configuration options.

## Provider Failover

The SDK includes automatic RPC provider failover to improve reliability when a single RPC endpoint fails. This feature allows you to configure multiple RPC endpoints per chain, with automatic failover to backup providers when the primary provider fails.

### Features

- **Multiple Providers**: Configure multiple RPC endpoints per chain (primary + fallbacks)
- **Fail-Fast Strategy**: Automatically switches to the next provider when the current one fails
- **Health Tracking**: Tracks provider health (failure counts, last failure time)
- **Automatic Recovery**: Failed providers are retried after a cooldown period
- **Thread-Safe**: Concurrent operations are handled safely with async locks

### Configuration

Provider failover is **enabled by default**. You can configure it via environment variables or `DexalotConfig`:

| Variable | Description | Default |
|----------|-------------|---------|
| `DEXALOT_PROVIDER_FAILOVER_ENABLED` | Enable/disable failover | `true` |
| `DEXALOT_PROVIDER_FAILOVER_COOLDOWN` | Seconds before retrying failed provider | `60` |
| `DEXALOT_PROVIDER_FAILOVER_MAX_FAILURES` | Max failures before marking provider unhealthy | `3` |

### RPC Provider Override

You can override RPC endpoints for specific chains using environment variables. This is useful for:
- Adding backup providers for redundancy
- Using custom RPC endpoints
- Testing with different providers

Two formats are supported:

1. **Chain ID format (preferred)**: `DEXALOT_RPC_<CHAIN_ID>=url1,url2,url3`
2. **Native token symbol format**: `DEXALOT_RPC_<NATIVE_TOKEN_SYMBOL>=url1,url2,url3`

Chain ID takes precedence over native token symbol if both are set. Examples:

```bash
# Chain ID format (preferred)
DEXALOT_RPC_43114=https://api.avax.network/ext/bc/C/rpc,https://avalanche.public-rpc.com
DEXALOT_RPC_1=https://eth.llamarpc.com,https://ethereum.public-rpc.com
DEXALOT_RPC_42161=https://arb1.arbitrum.io/rpc
DEXALOT_RPC_432204=https://subnets.avax.network/dexalot/mainnet/rpc

# Native token symbol format (alternative)
DEXALOT_RPC_AVAX=https://api.avax.network/ext/bc/C/rpc,https://avalanche.public-rpc.com
DEXALOT_RPC_ETH=https://eth.llamarpc.com,https://ethereum.public-rpc.com
DEXALOT_RPC_ALOT=https://subnets.avax.network/dexalot/mainnet/rpc
```

### How It Works

1. **Provider Initialization**: When the client initializes, it loads RPC endpoints from:
   - Environment variable overrides (if set)
   - API response (from Dexalot API)
   - Multiple URLs can be provided (comma-separated)

2. **Failover Strategy**: When an RPC call fails:
   - The failed provider is marked with a failure count
   - The SDK automatically tries the next available provider
   - If all providers fail, an error is raised

3. **Health Tracking**: Each provider tracks:
   - Failure count (incremented on each failure)
   - Last failure time (for cooldown calculation)
   - Health status (healthy/unhealthy)

4. **Recovery**: After the cooldown period, failed providers can be retried. Providers are marked as unhealthy only after exceeding the max failure threshold.

### Example

```typescript
import DexalotClient, { createConfig } from 'dexalot-sdk';

// Configure failover
const config = createConfig({
    providerFailoverEnabled: true,
    providerFailoverCooldown: 60,  // 60 seconds cooldown
    providerFailoverMaxFailures: 3,   // Mark unhealthy after 3 failures
});

const client = new DexalotClient(config);
await client.initializeClient();

// RPC calls use failover automatically when the primary provider fails (if enabled)
```

### Provider failover behavior

- With `providerFailoverEnabled: false`, only the primary RPC URL is used (no rotation).
- When the API returns a single provider entry, the client uses that URL directly.
- Environment variables can override failover settings as documented above.

## Observability

The SDK includes a comprehensive instrumentation layer to track API operations, performance metrics, and WebSocket events.

### Features

- **Structured Logging**: Logs are output in JSON format (or plain text) with metadata.
- **Performance Tracking**: Automatically tracks the duration of all core operations (`clob`, `swap`, `transfer`).
- **Security**: Designed with privacy by default:
  - **No Arguments**: Function arguments and return values are **never logged**.
  - **No Payloads**: Transaction payloads and private keys are **never logged**.
  - **Safe Defaults**: Minimal logging in production (`INFO`), detailed tracing only in `DEBUG`.

### Configuration

Control logging behavior using environment variables:

| Variable | Description | Default | Values |
|----------|-------------|---------|--------|
| `DEXALOT_LOG_LEVEL` | Logging verbosity | `INFO` | `DEBUG`, `INFO`, `WARN`, `ERROR` |
| `DEXALOT_LOG_FORMAT` | Log output format | `console` | `json`, `console` |

### Instrumented Components

- **CLOB**: Full coverage of Order Management (`add`/`cancel`/`replace`), Market Data (`orderbook`, `pairs`), and Account Data (`openOrders`).
- **Swap**: RFQ operation lifecycle including Firm/Soft Quotes and Swap Execution.
- **Transfer**: Cross-chain Bridge operations (`deposit`/`withdraw`), Portfolio Management (`transferPortfolio`), and comprehensive Balance queries.
- **WebSocket**: Connection lifecycle events (`Open`/`Close`/`Error`) and message traffic (at `DEBUG` level).

### Example Output

```json
{
  "timestamp": "2023-10-27T10:00:00Z",
  "level": "INFO",
  "logger": "dexalot_sdk.core.clob",
  "message": "clob completed in 0.123s",
  "extra_fields": {
    "operation": "clob",
    "function": "addOrder",
    "duration": 0.123,
    "status": "success"
  }
}
```

## Resource Cleanup

The SDK manages several resources that need proper cleanup:
- **HTTP sessions** (`axios` instances)
- **Web3 provider sessions** (internal HTTP sessions)
- **WebSocket connections** (if WebSocket manager is enabled)

### Always Close the Client

Always call `await client.close()` when you're done with the client to ensure proper resource cleanup:

```typescript
async function main() {
    let client: DexalotClient | null = null;
    try {
        client = new DexalotClient();
        await client.initializeClient();
        
        // Your operations here
        const result = await client.getTokens();
        if (result.success) {
            console.log(`Tokens: ${result.data}`);
        }
    } finally {
        // Always close the client in a finally block
        if (client !== null) {
            await client.close();
        }
    }
}
```

**Note:** The async `close()` method:
- Closes all HTTP sessions
- Closes WebSocket connections (if enabled)
- Resets rate limiters and nonce managers
- Is safe to call multiple times (idempotent)

## Async Usage

The SDK is **fully async** - all methods are `async` and must be awaited. This enables concurrent operations and better performance.

### Script Usage

For standalone scripts, use `async/await`:

```typescript
import DexalotClient from 'dexalot-sdk';

async function main() {
    let client: DexalotClient | null = null;
    try {
        client = new DexalotClient();
        await client.initializeClient();
        
        // Your async operations here
        const result = await client.getTokens();
        if (result.success) {
            console.log(`Tokens: ${result.data}`);
        }
    } finally {
        if (client !== null) {
            await client.close();
        }
    }
}

main().catch(console.error);
```

### Application Usage

In async applications (e.g., Node.js servers, async web frameworks), use `await` directly:

```typescript
import DexalotClient from 'dexalot-sdk';

// In Express.js or similar
const client = new DexalotClient();

// Initialize on startup
await client.initializeClient();

// Use in routes
app.get('/tokens', async (req, res) => {
    const result = await client.getTokens();
    if (result.success) {
        res.json(result.data);
    } else {
        res.status(500).json({ error: result.error });
    }
});

// Close on shutdown
process.on('SIGTERM', () => {
    void client.close();
});
```

### Parallel Operations

The async architecture enables parallel operations for better performance:

```typescript
import DexalotClient from 'dexalot-sdk';

async function main() {
    let client: DexalotClient | null = null;
    try {
        client = new DexalotClient();
        await client.initializeClient();
        
        // Fetch multiple orderbooks in parallel
        const pairs = ["AVAX/USDC", "ALOT/USDC", "ETH/USDC"];
        const results = await Promise.all(
            pairs.map(pair => client.getOrderBook(pair))
        );
        
        results.forEach((result, index) => {
            if (result.success) {
                console.log(`${pairs[index]}: ${result.data.bids.length} bids`);
            }
        });
    } finally {
        if (client !== null) {
            await client.close();
        }
    }
}

main().catch(console.error);
```

## Error Handling

The SDK uses a `Result<T>` pattern for consistent error handling across all methods.

### Result Pattern

All SDK methods return `Result<T>` with three fields:
- `success: boolean` - True if operation succeeded
- `data: T | null` - Result data on success, null on error
- `error: string | null` - Error message on failure, null on success

### Basic Error Handling

```typescript
const result = await client.addOrder({
    pair: "AVAX/USDC",
    side: "BUY",
    amount: 1.0,
    price: 25.0
});

if (result.success) {
    const txHash = result.data.txHash;
    console.log(`Order placed: ${txHash}`);
} else {
    console.error(`Order failed: ${result.error}`);
    // Handle error (retry, log, notify user, etc.)
}
```

### Validation Errors

Input validation errors are returned as `Result.fail()` with descriptive messages:

```typescript
// Invalid amount (negative)
const result = await client.addOrder({
    pair: "AVAX/USDC",
    side: "BUY",
    amount: -1.0,  // Invalid!
    price: 25.0
});

if (!result.success) {
    // result.error will be: "Invalid amount: must be positive (> 0), got -1.0"
    console.error(`Validation error: ${result.error}`);
}
```

### Error Sanitization

Error messages are automatically sanitized to prevent information leakage:
- File paths are removed
- URLs are removed
- Stack traces are removed
- User-friendly messages are provided

### Best Practices

1. **Always check `result.success`** before accessing `result.data`
2. **Handle errors appropriately** - log, retry, or notify users
3. **Use descriptive error messages** - the SDK provides clear error messages
4. **Don't expose internal errors** - error sanitization is automatic

```typescript
async function placeOrderSafely(
    client: DexalotClient,
    pair: string,
    side: string,
    amount: number,
    price: number
) {
    const result = await client.addOrder({ pair, side, amount, price });
    
    if (result.success) {
        return { status: "success", txHash: result.data.txHash };
    } else {
        // Log error for debugging
        console.error(`Order failed: ${result.error}`);
        // Return user-friendly message
        return { status: "error", message: "Failed to place order. Please try again." };
    }
}
```

## Transaction Receipt Handling

All state-changing operations (placing orders, deposits, withdrawals, etc.) now support a `waitForReceipt` parameter that controls whether the SDK waits for blockchain transaction confirmation before returning.

### Default Behavior

By default, **all state-changing operations wait for transaction receipts** (`waitForReceipt=true`). This ensures:
- Transactions are confirmed on-chain before the method returns
- Transaction failures are detected immediately
- More reliable operation results

### Usage

```typescript
// Default behavior: waits for receipt (recommended)
const result = await client.addOrder({
    pair: "AVAX/USDC",
    side: "BUY",
    amount: 1.0,
    price: 25.0
});
// Method returns only after transaction is confirmed

// Explicitly wait for receipt
const result = await client.addOrder({
    pair: "AVAX/USDC",
    side: "BUY",
    amount: 1.0,
    price: 25.0,
    waitForReceipt: true
});

// Don't wait for receipt (returns immediately after sending)
const result = await client.addOrder({
    pair: "AVAX/USDC",
    side: "BUY",
    amount: 1.0,
    price: 25.0,
    waitForReceipt: false
});
// Method returns immediately with transaction hash
// Transaction may still be pending
```

### When to Use `waitForReceipt=false`

Use `waitForReceipt=false` when:
- **Batch operations**: Sending many transactions and want to submit them quickly
- **Fire-and-forget**: You don't need immediate confirmation
- **Custom polling**: You'll check transaction status yourself

**Important**: When `waitForReceipt=false`, the SDK returns immediately after broadcasting the transaction. You should:
- Check transaction status yourself using the returned `txHash`
- Handle potential transaction failures in your application logic
- Be aware that the transaction may still be pending when the method returns

### Affected Methods

All state-changing methods support `waitForReceipt`:

**CLOB Operations:**
- `addOrder({ pair, side, amount, price, type?, waitForReceipt? })`
- `addOrderList(orders, waitForReceipt?)`
- `cancelOrder(orderId, waitForReceipt?)`
- `cancelListOrders(orderIds, waitForReceipt?)`
- `cancelListOrdersByClientId(clientOrderIds, waitForReceipt?)`
- `replaceOrder(orderId, newPrice, newAmount, waitForReceipt?)`
- `cancelAddList(replacements, waitForReceipt?)`

**Transfer Operations:**
- `deposit(token, amount, sourceChain, useLayerZero?, waitForReceipt?)`
- `withdraw(token, amount, destinationChain, useLayerZero?, waitForReceipt?)`
- `addGas(amount, waitForReceipt?)`
- `removeGas(amount, waitForReceipt?)`
- `transferPortfolio(token, amount, toAddress, waitForReceipt?)`

**Swap Operations:**
- `executeRFQSwap(quote, waitForReceipt?)`

### Example: Batch Order Placement

```typescript
// Place multiple orders without waiting for each receipt
const orders = [
    { pair: "AVAX/USDC", side: "BUY", amount: 1.0, price: 25.0 },
    { pair: "AVAX/USDC", side: "BUY", amount: 2.0, price: 24.0 },
    { pair: "AVAX/USDC", side: "SELL", amount: 1.0, price: 26.0 },
];

// Submit all orders quickly without waiting
const result = await client.addOrderList(orders, false);
if (result.success) {
    const txHash = result.data.txHash;
    // Check status later
    // await checkTransactionStatus(txHash);
}
```

### Example: Fire-and-Forget Deposit

```typescript
// Submit deposit and continue with other operations
const result = await client.deposit("AVAX", 1.0, "Avalanche", false, false);
if (result.success) {
    const txHash = result.data; // Just the transaction hash
    // Continue with other operations
    // Monitor deposit status separately
}
```

### Canonical Order Model

Order reads (`getOpenOrders`, `getOrder`, `getOrderByClientId`) return one canonical order object regardless of whether the source was the REST API or the contract:

- `internalOrderId`, `clientOrderId`, `tradePairId`, `pair`
- `price`, `totalAmount`, `quantity`, `quantityFilled`, `totalFee`
- `traderAddress`, `side`, `type1`, `type2`, `status`
- `updateBlock`, `createBlock`, `createTs`, `updateTs`

Enum-style fields are normalized to human-readable strings such as `BUY`, `SELL`, `LIMIT`, `GTC`, and `FILLED`. `createBlock` and `updateBlock` are returned as JavaScript numbers, not hex strings.

## API Field Name Standardization

The SDK automatically standardizes API response field names to match TypeScript naming conventions (camelCase). This ensures consistent field names regardless of API response format variations.

### Standardized Fields

**Orders API:**
- `internalOrderId` (from `id`)
- `clientOrderId` (from `clientordid`, `client_order_id`)
- `tradePairId` (from `tradePairId`, `tradepairid`, `trade_pair_id`, or derived from `pair`)
- `pair`, `price`, `quantity`, `quantityFilled`, `totalAmount`, `totalFee`
- `traderAddress`, `side`, `type1`, `type2`, `status`
- `createBlock`, `updateBlock`, `createTs`, `updateTs`

Orders are normalized into one canonical SDK shape across REST and contract order reads.

**Environments API:**
- `chainId` (from `chainid`, `chain_id`)
- `envType` (from `type`, `env_type`)
- `rpc` (from `chain_instance`)
- `network` (from `chain_display_name`)

**Tokens API:**
- `evmDecimals` (from `evmdecimals`, `evm_decimals`, `decimals`)
- `chainId` (from `chainid`, `chain_id`)
- `network` (from `chain_display_name`)

**Pairs API:**
- `base_decimals`, `quote_decimals`
- `base_display_decimals`, `quote_display_decimals`
- `min_trade_amount`, `max_trade_amount`

**RFQ Quotes API:**
- `chainId` (from `chainid`, `chain_id`)
- `secureQuote` (from `securequote`, `secure_quote`)
- `quoteId` (from `quoteid`, `quote_id`)
- Nested order data: `nonceAndMeta`, `makerAsset`, `takerAsset`, `makerAmount`, `takerAmount`

**Deployment API:**
- `env`, `address`, `abi` (handles variations like `Env`, `Address`, `Abi`)

### Benefits

- **Consistent interface**: Field names are exposed in camelCase in TypeScript.
- **Alias handling**: Common snake_case and alternate keys from the API are normalized automatically.

All API responses are automatically transformed before being returned, so you can always rely on standardized field names.

## Reliability Features

The SDK includes several reliability features that work automatically to improve stability and performance.

### Retry Mechanism

Automatic retry with exponential backoff for transient failures:

- **Default**: 3 attempts with exponential backoff (1s, 2s, 4s)
- **Retries on**: HTTP 429, 500, 502, 503, 504 and network errors
- **Configurable**: Via `DexalotConfig` or environment variables

```typescript
import DexalotClient, { createConfig } from 'dexalot-sdk';

// Custom retry configuration
const config = createConfig({
    retryEnabled: true,
    retryMaxAttempts: 5,
    retryInitialDelay: 2000,  // Start with 2s delay
    retryMaxDelay: 30000,      // Max 30s between retries
    retryExponentialBase: 2.0
});

const client = new DexalotClient(config);
```

### Rate Limiting

Token bucket rate limiter prevents API throttling:

- **Default**: 5 requests/second for API, 10 requests/second for RPC
- **Automatic**: Applied to all HTTP and RPC calls
- **Configurable**: Via `DexalotConfig` or environment variables

```typescript
const config = createConfig({
    rateLimitEnabled: true,
    rateLimitRequestsPerSecond: 10.0,  // 10 API calls/second
    rateLimitRpcPerSecond: 20.0         // 20 RPC calls/second
});
```

### Nonce Manager

Automatic nonce management prevents transaction race conditions:

- **Automatic**: Tracks nonces per (chain_id, address) combination
- **Thread-safe**: Uses async locks for concurrent transactions
- **Default-on**: No manual nonce bookkeeping for normal use

The nonce manager is enabled by default and works automatically. It:
1. Fetches the current nonce from the chain on first use
2. Tracks nonces locally for subsequent transactions
3. Automatically increments nonces for each transaction
4. Prevents race conditions in concurrent scenarios

```typescript
// Nonce manager works automatically - no configuration needed
// For high-concurrency scenarios, it's already handling nonces correctly

// Multiple transactions can be sent concurrently
const tasks = [
    client.addOrder({ pair: "AVAX/USDC", side: "BUY", amount: 1.0, price: 25.0 }),
    client.addOrder({ pair: "ALOT/USDC", side: "BUY", amount: 10.0, price: 0.5 }),
    client.deposit("AVAX", 1.0)
];
const results = await Promise.all(tasks);
// Nonce manager ensures correct nonce ordering
```

### Provider Failover

Automatic RPC provider failover (see [Provider Failover](#provider-failover) section above).

## WebSocket Manager

The SDK includes a persistent WebSocket manager for long-running subscriptions with automatic reconnection and heartbeat.

### Features

- **Persistent Connections**: Single connection for multiple subscriptions
- **Multiple Subscriptions**: Subscribe to multiple topics with individual callbacks
- **Automatic Reconnection**: Exponential backoff reconnection on failures
- **Heartbeat Monitoring**: Ping/pong mechanism to detect dead connections
- **Thread-Safe**: Safe for concurrent use

### Basic Usage

```typescript
import DexalotClient, { createConfig } from 'dexalot-sdk';

async function main() {
    let client: DexalotClient | null = null;
    try {
        const config = createConfig({
            wsManagerEnabled: true
        });
        client = new DexalotClient(config);
        await client.initializeClient();
        
        // Subscribe to orderbook updates
        const onOrderbookUpdate = (message: any) => {
            console.log(`Orderbook update: ${JSON.stringify(message)}`);
        };
        
        await client.subscribeToEvents(
            "orderbook.AVAX/USDC",
            onOrderbookUpdate,
            false
        );
        
        // Subscribe to private order updates
        const onOrderUpdate = (message: any) => {
            console.log(`Order update: ${JSON.stringify(message)}`);
        };
        
        await client.subscribeToEvents(
            "orders",
            onOrderUpdate,
            true
        );
        
        // Keep connection alive
        await new Promise(resolve => setTimeout(resolve, 60000));
        
        // Unsubscribe when done
        await client.unsubscribeFromEvents("orderbook.AVAX/USDC");
    } finally {
        // Always close the client to clean up WebSocket and HTTP sessions
        if (client !== null) {
            await client.close();
        }
    }
}

main().catch(console.error);
```

### Configuration

```typescript
import DexalotClient, { createConfig } from 'dexalot-sdk';

const config = createConfig({
    wsManagerEnabled: true,
    wsPingInterval: 30,        // Ping every 30 seconds
    wsPingTimeout: 10,         // Wait 10s for pong before reconnecting
    wsReconnectInitialDelay: 1,
    wsReconnectMaxDelay: 60,
    wsReconnectExponentialBase: 2.0,
    wsReconnectMaxAttempts: 10  // 0 = infinite retries
});

const client = new DexalotClient(config);
```

## Input Validation

The SDK automatically validates all input parameters before processing operations. This prevents invalid data from reaching the blockchain or API. Validation is implemented in `utils/input_validators.ts` and returns `Result<null>` for consistent error handling.

### Automatic Validation

Input validation is applied to all critical methods:

- **CLOB Operations**: `addOrder()`, `cancelOrder()`, `getOrderBook()`, etc.
- **Swap Operations**: `executeRfqSwap()`, `getSwapFirmQuote()`, etc.
- **Transfer Operations**: `deposit()`, `withdraw()`, `transferPortfolio()`, etc.

### Validation Rules

- **Amounts**: Must be positive, finite numbers (not NaN or infinite)
- **Prices**: Must be positive, finite numbers
- **Addresses**: Must be valid Ethereum addresses (0x prefix, 42 chars, hex)
- **Pairs**: Must be in `TOKEN/TOKEN` format
- **Order IDs**: Must be valid hex strings or bytes32 format
- **Token Symbols**: Must be non-empty, alphanumeric strings

### Handling Validation Errors

Validation errors are returned as `Result.fail()` with descriptive messages:

```typescript
// Invalid amount
const result = await client.addOrder({
    pair: "AVAX/USDC",
    side: "BUY",
    amount: -1.0,  // Invalid: negative amount
    price: 25.0
});

if (!result.success) {
    // result.error: "Invalid amount: must be positive (> 0), got -1.0"
    console.error(result.error);
}

// Invalid address
const balanceResult = await client.getPortfolioBalance(
    "USDC",
    "invalid"  // Not a valid Ethereum address
);
if (!balanceResult.success) {
    // result.error: "Invalid address: must be a valid Ethereum address (0x prefix, 42 chars, hex)"
    console.error(balanceResult.error);
}
```

### Common Validation Errors

| Error | Cause | Solution |
|-------|-------|----------|
| "Invalid amount: must be positive" | Negative or zero amount | Use positive values |
| "Invalid address: must be a valid Ethereum address" | Invalid address format | Use 0x-prefixed hex addresses |
| "Invalid pair: must be in TOKEN/TOKEN format" | Invalid pair format | Use format like "AVAX/USDC" |
| "Invalid order_id: must be hex string or bytes32" | Invalid order ID | Use valid hex string |

Validation happens before any network calls, so invalid inputs fail fast with clear error messages.
