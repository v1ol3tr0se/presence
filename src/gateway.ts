import WebSocket from "ws";
import { setTimeout as sleep } from "node:timers/promises";
import { log } from "./log.js";
import type { Config } from "./config.js";
import {
	Opcode,
	type Activity,
	type CustomStatus,
	type EmojiHolder,
	type GuildEmoji,
	type HelloData,
	type Payload,
	type Presence,
	type ReadyData,
	type UserSettings
} from "./types.js";

const ENTRY_URL = "wss://gateway.discord.gg/?v=9&encoding=json";

const RESUME_DELAY_MS = 1_000;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_CAP_MS = 60_000;

const CLOSE_ZOMBIE = 4000;

const UNRESUMABLE = new Set([1000, 1001, 4007, 4009, 4010, 4011, 4012, 4013, 4014]);

const CLOSE_AUTH_FAILED = 4004;

export class FatalGatewayError extends Error {}

interface Disconnect {
	code: number;
	reason: string;
}

interface Session {
	id: string;
	resumeUrl: string;
	sequence: number | null;
}

export class PresenceClient {
	private readonly config: Config;
	private session: Session | null = null;
	private failures = 0;
	private stopping = false;
	private socket: WebSocket | null = null;

	private readonly shutdown = new AbortController();

	private customStatus: CustomStatus | null = null;

	private readonly emojis = new Map<string, GuildEmoji>();

	private expiry: NodeJS.Timeout | undefined;

	private published = "";

	public constructor(config: Config) {
		this.config = config;
	}

	public async run(): Promise<void> {
		while (!this.stopping) {
			const resuming = this.session !== null;
			const url = this.session?.resumeUrl ?? ENTRY_URL;

			const { code, reason } = await this.connect(url, resuming);
			if (this.stopping) {
				return;
			}

			if (code === CLOSE_AUTH_FAILED) {
				throw new FatalGatewayError("Discord rejected the token (4004). It is revoked or malformed.");
			}

			if (UNRESUMABLE.has(code)) {
				this.session = null;
			}

			const delay = this.session ? RESUME_DELAY_MS : this.backoff();
			log.warn(`Disconnected (${code}${reason ? `: ${reason}` : ""}). Reconnecting in ${Math.round(delay / 1000)}s.`);
			await sleep(delay, undefined, { signal: this.shutdown.signal }).catch(() => {});
		}
	}

	public stop(): void {
		this.stopping = true;
		this.shutdown.abort();
		this.socket?.close(1000, "shutting down");
	}

	private backoff(): number {
		const ceiling = Math.min(BACKOFF_BASE_MS * 2 ** this.failures, BACKOFF_CAP_MS);
		this.failures++;
		return BACKOFF_BASE_MS + Math.random() * (ceiling - BACKOFF_BASE_MS);
	}

	private connect(url: string, resuming: boolean): Promise<Disconnect> {
		return new Promise<Disconnect>((resolve) => {
			const socket = new WebSocket(url);
			this.socket = socket;

			let heartbeatTimer: NodeJS.Timeout | undefined;
			let acknowledged = true;
			let settled = false;
			let unpublished = true;

			const finish = (code: number, reason: string): void => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(heartbeatTimer);
				clearTimeout(this.expiry);
				socket.onopen = null;
				socket.onmessage = null;
				socket.onerror = null;
				socket.onclose = null;
				if (this.socket === socket) {
					this.socket = null;
				}
				resolve({ code, reason });
			};

			const send = (op: Opcode, d: unknown): void => {
				if (socket.readyState === WebSocket.OPEN) {
					socket.send(JSON.stringify({ op, d }));
				}
			};

			const syncPresence = (): void => {
				clearTimeout(this.expiry);
				const presence = this.presence();
				const frame = JSON.stringify(presence);
				const changed = frame !== this.published;

				if (changed) {
					const [activity] = presence.activities;
					log.info(`Custom status: ${activity ? `${activity.emoji?.name ?? ""} ${activity.state ?? ""}`.trim() : "none"}`);
				}

				if (changed || unpublished) {
					unpublished = false;
					this.published = frame;
					send(Opcode.PresenceUpdate, presence);
				}

				const expiresAt = this.customStatus?.expires_at;
				const remaining = expiresAt ? Date.parse(expiresAt) - Date.now() : 0;
				if (remaining > 0) {
					this.expiry = setTimeout(syncPresence, Math.min(remaining + 1_000, 2_147_483_647));
				} else if (expiresAt) {
					this.customStatus = null;
				}
			};

			const beat = (): void => {
				if (!acknowledged) {
					log.warn("Heartbeat went unacknowledged; the connection is a zombie.");
					socket.close(CLOSE_ZOMBIE, "heartbeat timeout");
					finish(CLOSE_ZOMBIE, "heartbeat timeout");
					return;
				}
				acknowledged = false;
				send(Opcode.Heartbeat, this.session?.sequence ?? null);
			};

			socket.onerror = (): void => {};

			socket.onclose = (event): void => finish(event.code, event.reason);

			socket.onmessage = (event): void => {
				let payload: Payload;
				try {
					payload = JSON.parse(String(event.data)) as Payload;
				} catch {
					log.warn("Discarded a malformed gateway frame.");
					return;
				}

				if (payload.s !== null && this.session) {
					this.session.sequence = payload.s;
				}

				switch (payload.op) {
					case Opcode.Hello: {
						const { heartbeat_interval: interval } = payload.d as HelloData;

						heartbeatTimer = setTimeout(() => {
							beat();
							heartbeatTimer = setInterval(beat, interval);
						}, interval * Math.random());

						if (resuming && this.session) {
							send(Opcode.Resume, {
								token: this.config.token,
								session_id: this.session.id,
								seq: this.session.sequence
							});
						} else {
							send(Opcode.Identify, {
								token: this.config.token,
								properties: { os: "Linux", browser: "Chrome", device: "" },
								presence: this.presence(),
								compress: false
							});
						}
						break;
					}

					case Opcode.HeartbeatAck:
						acknowledged = true;
						break;

					case Opcode.Heartbeat:
						acknowledged = false;
						send(Opcode.Heartbeat, this.session?.sequence ?? null);
						break;

					case Opcode.Reconnect:
						log.info("Gateway asked us to reconnect.");
						socket.close(CLOSE_ZOMBIE, "server requested reconnect");
						break;

					case Opcode.InvalidSession:
						if (payload.d !== true) {
							this.session = null;
						}
						log.warn("Session invalidated by the gateway.");
						socket.close(CLOSE_ZOMBIE, "invalid session");
						break;

					case Opcode.Dispatch:
						if (payload.t === "READY") {
							const data = payload.d as ReadyData;
							this.session = {
								id: data.session_id,
								resumeUrl: data.resume_gateway_url
									? `${data.resume_gateway_url}/?v=9&encoding=json`
									: ENTRY_URL,
								sequence: payload.s
							};
							this.failures = 0;
							log.info(`Online as ${data.user.username} (${data.user.id}) [${this.config.status}].`);

							if (data.user_settings) {
								this.customStatus = data.user_settings.custom_status ?? null;
							} else {
								log.warn("READY carried no user_settings; the custom status cannot be mirrored.");
							}
							data.guilds?.forEach((guild) => this.remember(guild));
							syncPresence();

							setImmediate(() => (globalThis as { gc?: () => void }).gc?.());
						} else if (payload.t === "RESUMED") {
							this.failures = 0;
							log.info("Session resumed.");

							if (this.customStatus?.expires_at) {
								syncPresence();
							}
						} else if (payload.t === "USER_SETTINGS_UPDATE") {
							const settings = payload.d as UserSettings;
							if ("custom_status" in settings) {
								this.customStatus = settings.custom_status ?? null;
								syncPresence();
							}
						} else if (payload.t === "GUILD_CREATE" || payload.t === "GUILD_EMOJIS_UPDATE") {
							const guild = payload.d as EmojiHolder;
							const wanted = this.customStatus?.emoji_id;
							if (this.remember(guild) && guild.emojis?.some((emoji) => emoji.id === wanted)) {
								syncPresence();
							}
						}
						break;
				}
			};
		});
	}

	private remember(guild: EmojiHolder): boolean {
		return guild.emojis?.reduce((added, emoji) => {
			const known = this.emojis.get(emoji.id);
			this.emojis.set(emoji.id, { id: emoji.id, name: emoji.name, animated: emoji.animated });
			return added || known?.name !== emoji.name || known?.animated !== emoji.animated;
		}, false) ?? false;
	}

	private presence(): Presence {
		return {
			status: this.config.status,
			since: 0,
			activities: this.activities(),
			afk: false
		};
	}

	private activities(): Activity[] {
		const status = this.customStatus;
		if (!status || (status.expires_at && Date.parse(status.expires_at) <= Date.now())) {
			return [];
		}

		const activity: Activity = { type: 4, name: "Custom Status", state: status.text || null };

		if (status.emoji_id) {
			const emoji = this.emojis.get(status.emoji_id);
			const name = emoji?.name ?? status.emoji_name;
			if (name) {
				activity.emoji = { id: status.emoji_id, name, animated: emoji?.animated ?? false };
			}
		} else if (status.emoji_name) {
			activity.emoji = { name: status.emoji_name };
		}

		return activity.state || activity.emoji ? [activity] : [];
	}
}
