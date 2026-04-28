import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": "http://localhost:8001",
      "/browse": "http://localhost:8001",
      "/ws": {
        target: "ws://localhost:8001",
        ws: true
      }
    }
  }
});
