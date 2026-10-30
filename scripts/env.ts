import { existsSync, readFileSync } from "node:fs";

/**
 * Loads .env.local and .env into process.env for scripts, the same way
 * Next.js does for the web app: variables already set in the shell win, then
 * .env.local, then .env, and within a file the last line for a name wins.
 */
export function loadEnv(paths = [".env.local", ".env"]) {
  const fromShell = new Set(Object.keys(process.env));
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const values = new Map<string, string>();
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
      if (m) values.set(m[1], m[2]);
    }
    for (const [key, value] of values) if (!fromShell.has(key) && process.env[key] === undefined) process.env[key] = value;
  }
}
