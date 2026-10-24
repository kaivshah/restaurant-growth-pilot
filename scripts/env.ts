import { existsSync, readFileSync } from "node:fs";

/** Loads .env into process.env for scripts (Next.js does this for the web app). Existing variables win. */
export function loadEnv(path = ".env") {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
