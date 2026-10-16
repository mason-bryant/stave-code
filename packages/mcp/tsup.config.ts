import { defineConfig } from 'tsup'

export default defineConfig({
  // One entry: the CLI Claude Code launches. The protocol module is shared with
  // the app as TypeScript source (see package.json `exports`), so it is not built.
  entry: ['src/cli.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  clean: true,
  splitting: false,
  banner: { js: '#!/usr/bin/env node' },
})
