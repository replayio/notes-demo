import { defineConfig } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'

// docstream packages ship raw TS/TSX (main: ./src/index.ts), so they must be
// transpiled rather than externalized for SSR. The rich editor + mermaid render
// are mounted client-only, so they never execute on the server.
const TRANSPILE_PACKAGES = [
  '@brett_lamy/docstream-editor',
  '@brett_lamy/docstream',
  'streamdown',
  /^@tiptap\//,
  /^@codemirror\//,
  'y-codemirror.next',
  'lucide-react',
]

export default defineConfig({
  server: {
    port: 3000,
  },
  ssr: {
    noExternal: TRANSPILE_PACKAGES,
  },
  optimizeDeps: {
    include: ['@brett_lamy/docstream-editor', '@brett_lamy/docstream'],
  },
  plugins: [
    nitro({ rollupConfig: { external: [/^@sentry\//] } }),
    tsconfigPaths({ projects: ['./tsconfig.json'] }),
    tanstackStart(),
    viteReact(),
  ],
})
