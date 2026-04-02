const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');

// Try to load .env from various locations
// 1. local package .env
// 2. dexalot-mcp .env (common dev location)
// 3. typescript monorepo root .env
// 4. repo root .env
const paths = [
    path.resolve(__dirname, '.env'),
    path.resolve(__dirname, '../dexalot-mcp/.env'),
    path.resolve(__dirname, '../.env'),
    path.resolve(__dirname, '../../.env')
];

for (const p of paths) {
    if (fs.existsSync(p)) {
        //console.log(`[Jest Setup] Loading env from ${p}`);
        dotenv.config({ path: p });
        // We generally only want one .env source, but could merge if needed. 
        // For now, first found wins.
        break;
    }
}
