export enum Opcode {
	Dispatch = 0,
	Heartbeat = 1,
	Identify = 2,
	PresenceUpdate = 3,
	Resume = 6,
	Reconnect = 7,
	InvalidSession = 9,
	Hello = 10,
	HeartbeatAck = 11
}

export type Status = "online" | "idle" | "dnd" | "invisible";

export interface Payload {
	op: Opcode;
	d: unknown;
	s: number | null;
	t: string | null;
}

export interface HelloData {
	heartbeat_interval: number;
}

export interface ReadyData {
	session_id: string;

	resume_gateway_url?: string;
	user: {
		id: string;
		username: string;
	};

	user_settings?: UserSettings;
	guilds?: EmojiHolder[];
}

export interface UserSettings {
	custom_status?: CustomStatus | null;
}

export interface CustomStatus {
	text?: string | null;
	emoji_id?: string | null;
	emoji_name?: string | null;

	expires_at?: string | null;
}

export interface EmojiHolder {
	emojis?: GuildEmoji[];
}

export interface GuildEmoji {
	id: string;
	name: string;
	animated?: boolean;
}

export interface ActivityEmoji {
	id?: string;
	name: string;
	animated?: boolean;
}

export interface Activity {
	type: 4;
	name: "Custom Status";
	state: string | null;
	emoji?: ActivityEmoji;
}

export interface Presence {
	status: Status;
	since: number;
	activities: Activity[];
	afk: boolean;
}
