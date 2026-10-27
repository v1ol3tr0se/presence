import { join } from "node:path";
import type { Status } from "./types.js";

const STATUSES: readonly string[] = ["online", "idle", "dnd", "invisible"];

export interface Config {
	token: string;
	status: Status;
}

export class ConfigError extends Error {}

function loadEnvFile(): void {
	try {
		process.loadEnvFile(join(import.meta.dirname, "..", ".env"));
	} catch {}
}

export function loadConfig(): Config {
	loadEnvFile();

	const token = process.env.DISCORD_OAUTH_TOKEN?.trim();
	if (!token) {
		throw new ConfigError("DISCORD_OAUTH_TOKEN is empty. Copy .env.example to .env and fill it in.");
	}

	const status = process.env.STATUS?.trim() || "online";
	if (!STATUSES.includes(status)) {
		throw new ConfigError(`STATUS must be one of ${STATUSES.join(", ")} (got "${status}").`);
	}

	return {
		token,
		status: status as Status
	};
}
