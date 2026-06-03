import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/wax-auth.js',
      name: 'WaxAuth',
      formats: ['iife'],
    },
    outDir: 'shared',
    emptyOutDir: false,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        entryFileNames: 'wax-auth.js',
        assetFileNames: 'wax-auth.[ext]',
      },
    },
  },
});
