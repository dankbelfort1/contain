import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: "../dist-ui", emptyOutDir: true },
  server: {
    port: 5173,
    // The API runs in the same process as the loop, so the dev server proxies to it
    // rather than reimplementing anything.
    proxy: { "/api": "http://localhost:8910" },
  },
});
