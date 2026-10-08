import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
        devOptions: {
          enabled: false,
        },
        includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'icon.svg'],
        manifest: {
          id: '/',
          name: 'V to A - Video to Audio Converter',
          short_name: 'V to A',
          description: 'ইউটিউব, ফেসবুক, টিকটক, ইনস্টাগ্রাম লিঙ্ক বা যেকোনো ভিডিও থেকে সহজে MP3, AAC, OGG ও WAV অডিওতে কনভার্ট করার অ্যাপ।',
          theme_color: '#e11d48',
          background_color: '#f8fafc',
          display: 'standalone',
          start_url: '/',
          scope: '/',
          icons: [
            {
              src: '/pwa-192x192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/pwa-maskable-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},

      // ------------------------------------------------------------------
      // RENDER FIX (গুরুত্বপূর্ণ):
      // বাইরের ডোমেইন (vtoa-maruf.onrender.com) থেকে আসা রিকোয়েস্ট যেন
      // ডেভ-সার্ভার ব্লক না করে। আগের এরর:
      // "Blocked request. This host is not allowed. ... allowedHosts ..."
      // ------------------------------------------------------------------
      host: true,
      port: process.env.PORT ? parseInt(process.env.PORT, 10) : 5173,
      allowedHosts: ['.onrender.com', 'localhost', '127.0.0.1'],
      // সব হোস্ট খুলে দিতে চাইলে উপরের লাইনের বদলে: allowedHosts: true as const,
    },
    preview: {
      host: true,
      port: process.env.PORT ? parseInt(process.env.PORT, 10) : 4173,
      allowedHosts: ['.onrender.com', 'localhost', '127.0.0.1'],
    },
  };
});