import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: [
      // Das Actions-Paket importiert das gebaute Lesepaket; CI testet vor dem Bau, also zeigt der Alias auf src/.
      { find: /^@redpop\/apple-mail-mcp\/dist\/(.*)\.js$/, replacement: fileURLToPath(new URL('./src/$1.ts', import.meta.url)) },
    ],
  },
  test: {
    include: ['tests/**/*.test.ts', 'packages/actions/tests/**/*.test.ts'],
    environment: 'node',
    env: { TZ: 'Europe/Berlin' },
  },
})
