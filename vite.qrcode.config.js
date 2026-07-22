import { defineConfig } from 'vite';

// Vendors @wharfkit/web-renderer's internal QR-SVG encoder as a standalone
// bundle — see src/qrcode-lib.js for why (real Reed-Solomon encoder, not
// hand-portable). Separate config so it stays independent of the other two.
export default defineConfig({
  build: {
    lib: {
      entry: 'src/qrcode-lib.js',
      name: 'QRCode',
      formats: ['iife'],
    },
    outDir: 'shared',
    emptyOutDir: false,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        entryFileNames: 'qrcode.js',
        assetFileNames: 'qrcode.[ext]',
      },
    },
  },
});
