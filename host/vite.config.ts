import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    allowedHosts: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@duckhunt/shared": path.resolve(__dirname, "../shared/src"),
    },
  },
});
