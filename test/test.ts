import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { registerHooks } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTlsServer } from "node:tls";
import WsWebSocket, { WebSocketServer } from "ws";
import { startFakeGateway } from "./fake-gateway.ts";

let passed = 0;
const check = (n: number, what: string, how: string, fn: () => void) => {
	try {
		fn();
	} catch (error) {
		console.error(`\n  ✗ ${n}. ${what}  [${how}]\n    ${(error as Error).message}\n`);
		process.exitCode = 1;
		return;
	}
	passed++;
	console.log(`  ✓ ${n.toString().padStart(2)}. ${what}  [${how}]`);
};
const code = (path: string) =>
	readFileSync(path, "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^\s*\/\/.*$/gm, "");
const gateway = code("dist/gateway.js");
const index = code("dist/index.js");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const KNOWN_GOOD = [
	"connection",
	"host",
	"sec-websocket-extensions",
	"sec-websocket-key",
	"sec-websocket-version",
	"upgrade"
];
const UNDICI_TELL = ["accept", "accept-encoding", "accept-language", "cache-control", "pragma", "sec-fetch-mode"];
const fake = await startFakeGateway({
	onIdentified: (socket, n) => {
		if (n === 1) {
			setTimeout(() => socket.close(4000, "test drop"), 400).unref();
		}
	}
});
registerHooks({
	load(url, context, nextLoad) {
		const result = nextLoad(url, context);
		if (!url.endsWith("/dist/gateway.js")) return result;
		return { ...result, source: String(result.source).replace("wss://gateway.discord.gg", fake.url) };
	}
});
const { PresenceClient }: typeof import("../src/gateway.ts") = await import(
	new URL("../dist/gateway.js", import.meta.url).href
);
const client = new PresenceClient({ token: "fake-token-for-the-local-server", status: "idle" });
client.run().catch(() => {});
await new Promise((resolve) => setTimeout(resolve, 2_500));
client.stop();
fake.stop();
const sent = fake.seen.frames;
const identify = sent.find((f) => f.op === 2);
const heartbeats = sent.filter((f) => f.op === 1);
const resume = sent.find((f) => f.op === 6);
const presences = sent.filter((f) => f.op === 3);
console.log(
	`\n  client upgrade: ${Object.keys(fake.seen.headers ?? {})
		.sort()
		.join(", ")}`
);
console.log(
	`  client sent:    ${sent.map((f) => `op${f.op}`).join(" ")}  across ${fake.seen.connections} connections\n`
);
check(1, "the client's own upgrade carries no User-Agent", "measured", () => {
	assert.ok(fake.seen.headers, "the client never connected");
	assert.equal(
		fake.seen.headers["user-agent"],
		undefined,
		`client sent user-agent: ${fake.seen.headers["user-agent"]}`
	);
});
check(2, "the client's upgrade is exactly the six headers ws sends", "measured", () =>
	assert.deepEqual(Object.keys(fake.seen.headers ?? {}).sort(), KNOWN_GOOD)
);
check(3, "the client IDENTIFYs with its token and browser properties", "measured", () => {
	assert.ok(identify, "no IDENTIFY was sent");
	assert.equal(identify.d.token, "fake-token-for-the-local-server");
	assert.equal(identify.d.properties.browser, "Chrome");
});
check(4, "the heartbeat carries the sequence, not null", "measured", () => {
	assert.ok(heartbeats.length > 0, "no heartbeat was sent");
	assert.ok(
		heartbeats.some((h) => h.d !== null),
		`every heartbeat sent d: null — ${JSON.stringify(heartbeats.map((h) => h.d))}`
	);
});
check(5, "a resumable drop produces a RESUME, not a second IDENTIFY", "measured", () => {
	assert.ok(fake.seen.connections > 1, "the client never reconnected");
	assert.ok(resume, `reconnected without resuming — sent ${sent.map((f) => `op${f.op}`).join(" ")}`);
	assert.equal(resume.d.session_id, "fake-session");
	assert.equal(sent.filter((f) => f.op === 2).length, 1, "spent a second IDENTIFY on a resumable drop");
});
check(6, "the account's custom status from READY is published", "measured", () => {
	const published = presences.find((f) => f.d.activities.length > 0);
	assert.ok(published, "no presence carrying the custom status was sent");
	assert.equal(published.d.status, "idle");
	assert.deepEqual(published.d.activities, [
		{ type: 4, name: "Custom Status", state: "testing", emoji: { name: "🔧" } }
	]);
});
type SocketClass = new (url: string) => { onerror: unknown };
function handshake(Ctor: SocketClass) {
	return new Promise<IncomingHttpHeaders>((resolve, reject) => {
		const server = createServer();
		const wss = new WebSocketServer({ server });
		wss.on("connection", (socket, req) => {
			socket.close();
			server.close();
			resolve(req.headers);
		});
		server.listen(0, () => {
			const c = new Ctor(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/?v=9&encoding=json`);
			c.onerror = () => {};
		});
		setTimeout(() => reject(new Error("handshake timed out")), 5_000).unref();
	});
}
function alpn(Ctor: SocketClass) {
	return new Promise<string[] | null>((resolve, reject) => {
		const dir = join(tmpdir(), "discord-online-test-tls");
		const key = join(dir, "key.pem");
		const cert = join(dir, "cert.pem");
		if (!existsSync(cert)) {
			mkdirSync(dir, { recursive: true });
			execFileSync(
				"openssl",
				[
					"req",
					"-x509",
					"-newkey",
					"rsa:2048",
					"-nodes",
					"-keyout",
					key,
					"-out",
					cert,
					"-days",
					"1",
					"-subj",
					"/CN=127.0.0.1"
				],
				{ stdio: "ignore" }
			);
		}
		let offered: string[] | null = null;
		const server = createTlsServer({
			key: readFileSync(key),
			cert: readFileSync(cert),
			ALPNCallback: ({ protocols }) => {
				offered = protocols;
				return undefined;
			}
		});
		server.on("tlsClientError", () => {});
		server.on("connection", () =>
			setTimeout(() => {
				server.close();
				resolve(offered);
			}, 500).unref()
		);
		server.listen(0, () => {
			const c = new Ctor(`wss://127.0.0.1:${(server.address() as AddressInfo).port}/`);
			c.onerror = () => {};
		});
		setTimeout(() => reject(new Error("TLS probe timed out")), 10_000).unref();
	});
}
const viaGlobal = await handshake(globalThis.WebSocket);
const alpnWs = await alpn(WsWebSocket);
const alpnGlobal = await alpn(globalThis.WebSocket);
console.log(`  ws ALPN:     ${JSON.stringify(alpnWs)}`);
console.log(`  undici ALPN: ${JSON.stringify(alpnGlobal)}`);
console.log(`  undici upgrade: ${Object.keys(viaGlobal).sort().join(", ")}\n`);
check(7, "undici would send user-agent: node — check 1 can fail", "control", () =>
	assert.equal(viaGlobal["user-agent"], "node")
);
check(8, "undici would send six extra headers — check 2 can fail", "control", () =>
	UNDICI_TELL.forEach((h) => assert.ok(viaGlobal[h] !== undefined, `undici lacks ${h}`))
);
check(9, "ws offers no ALPN where undici does, so the TLS fingerprints differ", "control", () => {
	assert.equal(alpnWs, null, `ws offered ALPN: ${JSON.stringify(alpnWs)}`);
	assert.ok(Array.isArray(alpnGlobal) && alpnGlobal.length > 0, "undici offered no ALPN");
});
const run = (env: NodeJS.ProcessEnv) =>
	spawnSync(process.execPath, ["dist/index.js"], {
		env: { PATH: process.env.PATH, HOME: "/nonexistent", ...env },
		encoding: "utf8",
		timeout: 15_000
	});
const noToken = run({ DISCORD_OAUTH_TOKEN: "" });
const badStatus = run({ DISCORD_OAUTH_TOKEN: "x", STATUS: "lurking" });
check(10, "a missing token exits 78, which systemd refuses to restart", "measured", () => {
	assert.equal(noToken.status, 78, `exited ${noToken.status}: ${noToken.stderr}`);
	assert.match(noToken.stderr, /DISCORD_OAUTH_TOKEN/);
});
check(11, "an invalid STATUS exits 78 rather than connecting", "measured", () => {
	assert.equal(badStatus.status, 78, `exited ${badStatus.status}: ${badStatus.stderr}`);
	assert.match(badStatus.stderr, /STATUS must be one of/);
});
check(12, "startup opens zero sockets before the config is valid", "measured", () => {
	const strace = spawnSync("strace", ["-f", "-e", "trace=connect", "-qq", process.execPath, "dist/index.js"], {
		env: { PATH: process.env.PATH, HOME: "/nonexistent", DISCORD_OAUTH_TOKEN: "" },
		encoding: "utf8",
		timeout: 15_000
	});
	if (strace.error) {
		throw new Error(`strace unavailable (${(strace.error as NodeJS.ErrnoException).code}); ran no syscall check`);
	}
	const inet = strace.stderr.split("\n").filter((l) => /connect\(.*sin_(addr|port)/.test(l));
	assert.equal(inet.length, 0, `opened ${inet.length} network connections:\n${inet.join("\n")}`);
});
check(13, "dist/gateway.js imports ws", "structural", () => assert.match(gateway, /^import WebSocket from "ws";$/m));
check(14, "no compiled file reaches for the global WebSocket", "structural", () => {
	for (const file of ["dist/gateway.js", "dist/index.js", "dist/config.js", "dist/log.js"]) {
		const body = code(file);
		if (/\bnew WebSocket\(/.test(body)) {
			assert.match(body, /^import WebSocket from "ws";$/m, `${file} constructs WebSocket without importing ws`);
		}
	}
});
check(15, "startup makes no REST call to check the token", "structural", () =>
	assert.doesNotMatch(index, /users\/@me|\bfetch\(/)
);
check(16, "no compiled file carries any other HTTP client", "structural", () =>
	[gateway, index, code("dist/config.js")].forEach((body) =>
		assert.doesNotMatch(body, /node-fetch|undici|require\(['"]https?['"]\)|from ['"]node:https?['"]/)
	)
);
check(17, "op 7 Reconnect and op 9 InvalidSession are both handled", "structural", () => {
	assert.match(gateway, /case Opcode\.Reconnect:/);
	assert.match(gateway, /case Opcode\.InvalidSession:/);
});
check(18, "the first heartbeat is jittered across the interval", "structural", () =>
	assert.match(gateway, /interval \* Math\.random\(\)/)
);
check(19, "4004 is fatal and never retried", "structural", () =>
	assert.match(gateway, /CLOSE_AUTH_FAILED[\s\S]{0,200}?throw new FatalGatewayError/)
);
check(20, "ws is a runtime dependency, ships to the VPS, and 78 stays unrestartable", "structural", () => {
	assert.ok(pkg.dependencies?.ws, "ws is not in dependencies");
	assert.ok(!pkg.devDependencies?.ws, "ws is in devDependencies, so it would not ship");
	assert.match(readFileSync("deploy/deploy.sh", "utf8"), /--relative node_modules\/ws/);
	assert.match(readFileSync("deploy/discord-online.service", "utf8"), /^RestartPreventExitStatus=78$/m);
});
check(21, "the installed unit runs from DEPLOY_DIR, not a hardcoded folder", "structural", () =>
	assert.match(readFileSync("deploy/deploy.sh", "utf8"), /WorkingDirectory=%h\/\$REMOTE_DIR\|/)
);
console.log(`\n  ${passed}/21 checks passed\n`);
if (process.exitCode) console.error("  FAILED — do not deploy\n");
