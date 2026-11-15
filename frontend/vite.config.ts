import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import type { ProxyOptions } from "vite";
import { defineConfig } from "vitest/config";

// Backend real (uvicorn) o servidor falso (backend/app/fake.py). Se puede
// cambiar sin tocar este archivo: $env:SPHEREX_API_TARGET = "http://127.0.0.1:8001"
const API_TARGET = process.env.SPHEREX_API_TARGET ?? "http://127.0.0.1:8000";

const EVENT_STREAM = "text/event-stream";

// Proxy de /api hacia el backend. El flujo SSE de /api/field/{id}/events tiene
// que llegar evento por evento, asi que para esas respuestas:
// - no se pide compresion al backend (un gzip intermedio retiene los eventos),
// - se marca la respuesta como no transformable ni almacenable en buffers,
// - se desactiva el algoritmo de Nagle en el socket del navegador.
// http-proxy no pone limite de tiempo por defecto, asi que el flujo puede durar
// los minutos que tarda un campo nuevo.
const apiProxy: ProxyOptions = {
  target: API_TARGET,
  changeOrigin: true,
  configure(proxy) {
    proxy.on("proxyReq", (proxyReq, req) => {
      if (req.headers.accept?.includes(EVENT_STREAM)) {
        proxyReq.removeHeader("accept-encoding");
      }
    });
    proxy.on("proxyRes", (proxyRes, _req, res) => {
      if (proxyRes.headers["content-type"]?.includes(EVENT_STREAM)) {
        proxyRes.headers["cache-control"] = "no-cache, no-transform";
        proxyRes.headers["x-accel-buffering"] = "no";
        res.socket?.setNoDelay(true);
      }
    });
  },
};

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    proxy: { "/api": apiProxy },
  },
  preview: {
    proxy: { "/api": apiProxy },
  },
  build: {
    target: "es2022",
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
