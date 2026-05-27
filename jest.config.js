module.exports = {
    preset: "ts-jest",
    testEnvironment: "node",
    testMatch: ["**/*.test.ts"],
    moduleFileExtensions: ["ts", "js", "json", "node"],
    collectCoverage: true,
    coverageDirectory: "coverage",
    collectCoverageFrom: ["src/**/*.ts", "!src/**/*.d.ts"],
    coveragePathIgnorePatterns: ["/node_modules/", "/dist/"],
    // Match Python SDK's --cov-fail-under=100 gate. Every PR has held
    // 100% line/branch/function/statement coverage on touched files;
    // this enforces the invariant going forward.
    coverageThreshold: {
        global: {
            lines: 100,
            statements: 100,
            branches: 100,
            functions: 100,
        },
    },
    moduleNameMapper: {
        "^(\\.{1,2}/.*)\\.js$": "$1",
    },
    setupFiles: ["./jest.setup.js"],
    setupFilesAfterEnv: ["./jest.setupAfterEnv.js"],
};
