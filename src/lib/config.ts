import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { prompt } from "./prompt.js";
import type { SyncConfig } from "../types.js";

interface ConfigFile {
  tokenV2?: string;
  userId?: string;
  mergeTool?: string;
  diffTool?: string;
}

const XDG_CONFIG_HOME =
  process.env["XDG_CONFIG_HOME"] || path.join(os.homedir(), ".config");
const CONFIG_DIR = path.join(XDG_CONFIG_HOME, "notion-sync");
const HOME_CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
// Legacy location, read for backward compatibility but no longer written to.
const LEGACY_HOME_CONFIG_PATH = path.join(os.homedir(), ".notion-sync.json");
const LOCAL_CONFIG_PATH = path.join(process.cwd(), ".notion-sync.json");

const TOKEN_INSTRUCTIONS = `
To get your token_v2 cookie:
  1. Open Notion in your browser and log in
  2. Open DevTools (F12) → Application → Cookies → https://www.notion.so
  3. Copy the value of the "token_v2" cookie

If the page you're syncing belongs to a team workspace, also copy the
"notion_user_id" cookie value (same Cookies panel). Without it, requests for
team-workspace pages fail with 403 Forbidden even with a valid token_v2.
Leave it blank if you only sync pages in your personal workspace.
`;

function readJsonFile(filePath: string): ConfigFile | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as ConfigFile;
  } catch {
    return null;
  }
}

// Settings adjustable via `notion-sync config`. tokenV2/userId are handled
// separately by the `auth` command, since they go through a credential prompt.
export const CONFIG_KEYS = ["mergeTool", "diffTool"] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

export function isConfigKey(key: string): key is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(key);
}

function targetPath(target: "home" | "local"): string {
  return target === "local" ? LOCAL_CONFIG_PATH : HOME_CONFIG_PATH;
}

function readTargetConfig(target: "home" | "local"): ConfigFile {
  if (target === "local") return readJsonFile(LOCAL_CONFIG_PATH) ?? {};
  return readJsonFile(HOME_CONFIG_PATH) ?? readJsonFile(LEGACY_HOME_CONFIG_PATH) ?? {};
}

export function setConfigValue(
  key: ConfigKey,
  value: string,
  target: "home" | "local" = "home",
): string {
  const existing = readTargetConfig(target);
  existing[key] = value;
  if (target === "home") fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const path = targetPath(target);
  fs.writeFileSync(path, JSON.stringify(existing, null, 2) + "\n");
  return path;
}

export function unsetConfigValue(
  key: ConfigKey,
  target: "home" | "local" = "home",
): string {
  const existing = readTargetConfig(target);
  delete existing[key];
  const path = targetPath(target);
  if (target === "home") fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path, JSON.stringify(existing, null, 2) + "\n");
  return path;
}

export function getConfigValue(
  key: ConfigKey,
): { value: string; source: "home" | "local" } | null {
  const local = readJsonFile(LOCAL_CONFIG_PATH);
  if (local?.[key]) return { value: local[key]!, source: "local" };

  const home =
    readJsonFile(HOME_CONFIG_PATH) ?? readJsonFile(LEGACY_HOME_CONFIG_PATH);
  if (home?.[key]) return { value: home[key]!, source: "home" };

  return null;
}

export function loadConfig(): SyncConfig | null {
  const homeConfig =
    readJsonFile(HOME_CONFIG_PATH) ?? readJsonFile(LEGACY_HOME_CONFIG_PATH);
  const localConfig = readJsonFile(LOCAL_CONFIG_PATH);
  const mergeTool = localConfig?.mergeTool ?? homeConfig?.mergeTool;
  const diffTool = localConfig?.diffTool ?? homeConfig?.diffTool;

  const envToken = process.env["NOTION_TOKEN_V2"];
  if (envToken) {
    const userId = process.env["NOTION_USER_ID"] ?? homeConfig?.userId ?? localConfig?.userId;
    return { tokenV2: envToken, userId, source: "env", mergeTool, diffTool };
  }

  if (homeConfig?.tokenV2) {
    return { tokenV2: homeConfig.tokenV2, userId: homeConfig.userId, source: "home", mergeTool, diffTool };
  }

  if (localConfig?.tokenV2) {
    return { tokenV2: localConfig.tokenV2, userId: localConfig.userId, source: "local", mergeTool, diffTool };
  }

  return null;
}

export function saveTokenToHomeConfig(tokenV2: string, userId?: string): void {
  // Preserve any existing settings, migrating from the legacy path if needed.
  const existing =
    readJsonFile(HOME_CONFIG_PATH) ?? readJsonFile(LEGACY_HOME_CONFIG_PATH) ?? {};
  existing.tokenV2 = tokenV2;
  if (userId) existing.userId = userId;
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
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
  const userId = await prompt("Paste your notion_user_id value (leave blank if not applicable): ");

  saveTokenToHomeConfig(token, userId || undefined);
  console.error(`Token saved to ${HOME_CONFIG_PATH}\n`);
  return { tokenV2: token, userId: userId || undefined, source: "home" };
}

export async function setToken(): Promise<void> {
  console.error(TOKEN_INSTRUCTIONS);

  const token = await prompt("Paste your token_v2 value: ");
  if (!token) {
    console.error("No token provided. Exiting.");
    process.exit(1);
  }
  const userId = await prompt("Paste your notion_user_id value (leave blank if not applicable): ");

  saveTokenToHomeConfig(token, userId || undefined);
  console.error(`Token saved to ${HOME_CONFIG_PATH}`);

  if (process.env["NOTION_TOKEN_V2"]) {
    console.error(
      "\nNote: the NOTION_TOKEN_V2 (and NOTION_USER_ID) environment variables are currently set " +
        "and take precedence over the saved config. Update or unset them for the new values to take effect.",
    );
  }
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
  const userIdInput = await prompt(
    `Paste your notion_user_id value (leave blank to keep${config.userId ? " current" : " unset"}): `,
  );
  const userId = userIdInput || config.userId;

  const configPath = config.source === "home" ? HOME_CONFIG_PATH : LOCAL_CONFIG_PATH;
  saveTokenToHomeConfig(token, userId);
  console.error(`Token updated in ${configPath}\n`);
  return { tokenV2: token, userId, source: config.source };
}
