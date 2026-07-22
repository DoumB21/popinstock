import { defineConfig } from 'vite';

// Separate small bundle for gift-crypto.js — deliberately its own config
// (not folded into vite.config.js) so it stays free of @wharfkit/session's
// SessionKit/wallet-plugin/UI weight that wax-auth.js needs. See
// src/gift-crypto.js for why this exists.
export default defineConfig({
  build: {
    lib: {
      entry: 'src/gift-crypto.js',
      name: 'GiftCrypto',
      formats: ['iife'],
    },
    outDir: 'shared',
    emptyOutDir: false,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        entryFileNames: 'gift-crypto.js',
        assetFileNames: 'gift-crypto.[ext]',
      },
    },
  },
});
