import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Os testes de banco compartilham um único banco de teste, então rodam
    // um arquivo por vez para não interferirem uns nos outros.
    fileParallelism: false,
    globalSetup: ["./test/global-setup.ts"],
  },
});
