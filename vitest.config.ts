// Vitest settings for the offline unit suite: `npm test`. The live suite has its own config (vitest.integration.config.ts), and the real-chain end to end is a script (scripts/e2e-localnet.mjs).
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Node, not jsdom: the package has no DOM code.
    environment: 'node',
    // Every unit test file under tests/.
    include: ['tests/**/*.test.ts'],
    // The integration tests need a network (GRPC_TESTNET), so they are excluded from the default run.
    exclude: ['node_modules/**', 'tests/integration/**'],
  },
})
