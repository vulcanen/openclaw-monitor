import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/monitor/",
  build: {
    outDir: "../dist/ui",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2020",
  },
  server: {
    port: 5173,
    proxy: {
      "/api/monitor": "http://localhost:7042",
    },
  },
});
