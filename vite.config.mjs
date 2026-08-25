import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  base: "./",
  build: {
    outDir: "dist/client",
    rollupOptions: {
      input: {
        main: resolve(process.cwd(), "index.html"),
        capture: resolve(process.cwd(), "capture.html"),
        screenshot: resolve(process.cwd(), "screenshot.html"),
        screenshotHistory: resolve(process.cwd(), "screenshot-history.html"),
        pin: resolve(process.cwd(), "pin.html"),
      },
    },
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react()],
});
