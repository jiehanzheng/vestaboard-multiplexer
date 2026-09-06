import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: {
    outDir: "../dist/web",
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
