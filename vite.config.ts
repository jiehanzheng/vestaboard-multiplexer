import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: {
    // Keep bundled assets separate from tsc output so browser-owned modules imported by tests survive the build.
    outDir: "../dist/public",
    emptyOutDir: true
  },
  server: {
    proxy: {
      "/api": {
        target: process.env.VBMUX_API_TARGET ?? "http://localhost:3000",
        changeOrigin: false
      }
    }
  }
});
