import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The PoW tests run real Keccak searches against the official wasm oracle; the
    // whole-range and chunked agreement tests alone take several seconds.
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
