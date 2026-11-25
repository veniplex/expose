import { defineConfig } from 'vite';

// `base: './'` keeps every asset URL relative so the build works under any
// sub-path (e.g. https://<user>.github.io/expose/).
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 900,
  },
});
