import { defineConfig } from "vitest/config";
import fs from "node:fs";

// Load .env.test into process.env before tests run
const envFile = ".env.test";
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf-8").split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  }
}

export default defineConfig({
  test: {},
});
