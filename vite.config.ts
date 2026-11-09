import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.json'

export default defineConfig({
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [
    react(),
    crx({ manifest }),
  ],
  build: {
    rollupOptions: {
      input: {
        guide: 'src/options/guide.html',
        offscreen: 'src/offscreen/index.html',
        crop: 'src/crop/index.html',
        sidepanel: 'src/sidepanel/index.html',
      },
    },
  },
})
