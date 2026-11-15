import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Vitest 用の独立設定。`vite.config.ts` は Tauri 開発サーバ向けの設定
// (TAURI_DEV_HOST、固定ポート 1420、HMR プロトコル等)を含むため、
// テスト実行時の副作用を避けて alias / plugin だけ揃える。
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: false,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    setupFiles: ["src/__tests__/setup.ts"],
  },
});
