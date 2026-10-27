const UNDER_JOURNALD = process.env.JOURNAL_STREAM !== undefined;

function write(stream: NodeJS.WriteStream, priority: number, message: string): void {
	stream.write(UNDER_JOURNALD ? `<${priority}>${message}\n` : `${new Date().toISOString()} ${message}\n`);
}

export const log = {
	info: (message: string): void => write(process.stdout, 6, message),
	warn: (message: string): void => write(process.stdout, 4, message),
	error: (message: string): void => write(process.stderr, 3, message)
};
