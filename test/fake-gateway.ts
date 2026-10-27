import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { type WebSocket, WebSocketServer } from "ws";
import type { Presence } from "../src/types.ts";

export type Frame =
	| { op: 1; d: number | null }
	| { op: 2; d: { token: string; properties: { browser: string }; presence: Presence } }
	| { op: 3; d: Presence }
	| { op: 6; d: { token: string; session_id: string; seq: number | null } };

interface Seen {
	headers: IncomingHttpHeaders | null;
	frames: Frame[];
	connections: number;
}

interface Options {
	onIdentified?: (socket: WebSocket, connection: number) => void;
}

export function startFakeGateway({ onIdentified }: Options = {}) {
	const seen: Seen = { headers: null, frames: [], connections: 0 };
	const server = createServer();
	const wss = new WebSocketServer({ server });
	const url = () => `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;

	wss.on("connection", (socket, req) => {
		seen.headers ??= req.headers;
		seen.connections++;
		const mine = seen.connections;

		socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 120 }, s: null, t: null }));

		socket.on("message", (raw) => {
			const frame = JSON.parse(String(raw));
			seen.frames.push(frame);

			if (frame.op === 2) {
				socket.send(
					JSON.stringify({
						op: 0,
						s: 7,
						t: "READY",
						d: {
							session_id: "fake-session",
							resume_gateway_url: url(),
							user: { id: "123456789012345678", username: "someone" },
							user_settings: { custom_status: { text: "testing", emoji_name: "🔧" } },
							guilds: []
						}
					})
				);
				onIdentified?.(socket, mine);
			} else if (frame.op === 6) {
				socket.send(JSON.stringify({ op: 0, s: 8, t: "RESUMED", d: {} }));
			} else if (frame.op === 1) {
				socket.send(JSON.stringify({ op: 11, d: null, s: null, t: null }));
			}
		});
	});

	return new Promise<{ url: string; seen: Seen; stop: () => void }>((resolve) => {
		server.listen(0, () =>
			resolve({
				url: url(),
				seen,
				stop: () => {
					wss.close();
					server.close();
				}
			})
		);
	});
}
