import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import type { SyncConfig } from "../types.js";

interface ConfigFile {
  tokenV2?: string;
  mergeTool?: string;
}

const HOME_CONFIG_PATH = path.join(os.homedir(), ".notion-sync.json");
const LOCAL_CONFIG_PATH = path.join(process.cwd(), ".notion-sync.json");

const TOKEN_INSTRUCTIONS = `
To get your token_v2 cookie:
  1. Open Notion in your browser and log in
  2. Open DevTools (F12) → Application → Cookies → https://www.notion.so
  3. Copy the value of the "token_v2" cookie
`;

function readJsonFile(filePath: string): ConfigFile | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as ConfigFile;
  } catch {
    return null;
  }
}

export function loadConfig(): SyncConfig | null {
  const homeConfig = readJsonFile(HOME_CONFIG_PATH);
  const localConfig = readJsonFile(LOCAL_CONFIG_PATH);
  const mergeTool = localConfig?.mergeTool ?? homeConfig?.mergeTool;

  const envToken = process.env["NOTION_TOKEN_V2"];
  if (envToken) {
    return { tokenV2: envToken, source: "env", mergeTool };
  }

  if (homeConfig?.tokenV2) {
    return { tokenV2: homeConfig.tokenV2, source: "home", mergeTool };
  }

  if (localConfig?.tokenV2) {
    return { tokenV2: localConfig.tokenV2, source: "local", mergeTool };
  }

  return null;
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function saveTokenToHomeConfig(tokenV2: string): void {
  let existing: ConfigFile = {};
  try {
    const raw = fs.readFileSync(HOME_CONFIG_PATH, "utf-8");
    existing = JSON.parse(raw) as ConfigFile;
  } catch {
    // file doesn't exist or invalid — start fresh
  }
  existing.tokenV2 = tokenV2;
  fs.writeFileSync(HOME_CONFIG_PATH, JSON.stringify(existing, null, 2) + "\n");
}

export async function handleMissingToken(): Promise<SyncConfig> {
  console.error("No Notion token configured.");
  console.error(TOKEN_INSTRUCTIONS);

  const token = await prompt("Paste your token_v2 value: ");
  if (!token) {
    console.error("No token provided. Exiting.");
    process.exit(1);
  }

  saveTokenToHomeConfig(token);
  console.error(`Token saved to ${HOME_CONFIG_PATH}\n`);
  return { tokenV2: token, source: "home" };
}

export async function handleStaleToken(
  config: SyncConfig,
): Promise<SyncConfig> {
  console.error("\nYour Notion token_v2 cookie has expired or is invalid.");
  console.error(TOKEN_INSTRUCTIONS);

  if (config.source === "env") {
    console.error(
      "Your token is set via the NOTION_TOKEN_V2 environment variable.",
    );
    console.error("Update that variable with a fresh token and retry.\n");
    process.exit(1);
  }

  const token = await prompt("Paste your new token_v2 value: ");
  if (!token) {
    console.error("No token provided. Exiting.");
    process.exit(1);
  }

  const configPath = config.source === "home" ? HOME_CONFIG_PATH : LOCAL_CONFIG_PATH;
  saveTokenToHomeConfig(token);
  console.error(`Token updated in ${configPath}\n`);
  return { tokenV2: token, source: config.source };
}
