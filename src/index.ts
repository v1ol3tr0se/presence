import { ConfigError, loadConfig } from "./config.js";
import { FatalGatewayError, PresenceClient } from "./gateway.js";
import { log } from "./log.js";

const EXIT_CONFIG = 78;

async function main(): Promise<void> {
	const config = loadConfig();

	const client = new PresenceClient(config);

	const shutdown = (signal: string): void => {
		log.info(`Received ${signal}; shutting down.`);
		client.stop();
	};
	process.once("SIGTERM", () => shutdown("SIGTERM"));
	process.once("SIGINT", () => shutdown("SIGINT"));

	await client.run();
	log.info("Stopped.");
}

try {
	await main();
} catch (error) {
	if (error instanceof ConfigError || error instanceof FatalGatewayError) {
		log.error(error.message);
		process.exit(EXIT_CONFIG);
	}
	log.error(`Unexpected failure: ${(error as Error).stack ?? String(error)}`);
	process.exit(1);
}
