// Module-level cache singletons live for the whole process; without an
// explicit per-test reset, one test's writes leak into the next test's
// reads. Clear before each test so each spec gets a clean cache state.
//
// Compiled output lives in dist/, so tests import from src/. Use the
// ts-jest pipeline by going through the same path the tests use.
const { clearAllCaches, resetCachesForTesting } = require('./src/utils/cache.ts');

beforeEach(() => {
    // Reset both the contents AND the TTL/size config so a test that
    // calls configureCaches doesn't leak its overrides into the next.
    resetCachesForTesting();
    clearAllCaches();
});
