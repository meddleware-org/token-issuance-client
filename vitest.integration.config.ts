import { defineConfig } from 'vitest/config'

// Live checks against public full nodes (testnet and mainnet). Gated by GRPC_TESTNET so they
// self-skip when unset. Run with: npm run test:integration
//
// Read-only and needs no key: it compares the client's expectations (the ABI table, the framework calls) with the real framework. CI runs it weekly (.github/workflows/live.yml), not on every push,
// because a public node can be slow or rate-limited.
export default defineConfig({
  test: {
    environment: 'node',
    // Only the files named `*.integration.test.ts`, so the default config never picks them up.
    include: ['tests/integration/**/*.integration.test.ts'],
    // A real node is slow: a minute per test.
    testTimeout: 60_000,
    // One file at a time, so a shared public node is not hit by several suites at once.
    fileParallelism: false,
  },
})
