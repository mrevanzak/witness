// The computer abstraction. One verification run = one fresh Computer, destroyed at
// the end. Docker is the MVP backend; E2B/Daytona implement the same interface later.

export type Action =
	| { type: "click" | "double_click" | "right_click" | "move"; x: number; y: number; button?: "left" | "middle" }
	| { type: "drag"; x: number; y: number; to_x: number; to_y: number }
	| { type: "type"; text: string; delay_ms?: number }
	| { type: "key"; combo: string }
	| { type: "scroll"; x?: number; y?: number; dx?: number; dy?: number }
	| { type: "wait"; ms: number };

export interface Screenshot {
	png: Buffer;
	cursor: { x: number; y: number };
	/** Wall-clock ms (computer clock) when the screenshot was taken. */
	at: number;
	/** Wall-clock ms when the action started, for /act. */
	actionAt?: number;
}

export interface ExecRequest {
	cmd: string;
	timeoutMs?: number;
	maxBytes?: number;
	cwd?: string;
	env?: Record<string, string>;
	/** Detach and return immediately; output goes to `log` (a path under /artifacts). */
	background?: boolean;
	log?: string;
}

export interface ExecResult {
	code: number | null;
	signal: string | null;
	timed_out: boolean;
	truncated: boolean;
	stdout: string;
	stderr: string;
}

export interface RecordingResult {
	/** Wall-clock ms (computer clock) of the first captured frame; step times are relative to it. */
	t0: number | null;
	duration: number;
	/** Paths inside the computer (under /artifacts). */
	mkv: string;
	mp4: string;
}

export interface PageElement {
	ref: string;
	tag: string;
	role?: string;
	type?: string;
	name: string;
	value?: string;
	checked?: boolean;
	disabled?: boolean;
	/** Centre in screen pixels. */
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface PageSnapshot {
	url: string;
	title: string;
	viewport: { x: number; y: number; w: number; h: number };
	text: string;
	elements: PageElement[];
}

export interface ConsoleMessage {
	at: number;
	type: string;
	text: string;
	url: string;
}

export interface NetworkEvent {
	at: number;
	kind: "failed" | "status";
	method: string;
	url: string;
	status?: number;
	error?: string;
}

export interface ServiceSpec {
	image: string;
	env?: Record<string, string>;
	port?: number;
	command?: string[];
}

export interface ComputerSpec {
	runId: string;
	/** Host directory bind-mounted at /artifacts. */
	artifactsDir: string;
	image?: string;
	env?: Record<string, string>;
	enableVnc?: boolean;
}

export interface Computer {
	readonly id: string;
	readonly runId: string;
	/** Network name the computer and its services share. */
	readonly network: string;
	/** Host URL of the noVNC live view, when enabled. */
	readonly liveViewUrl?: string;
	health(): Promise<{ ok: boolean; browser: boolean; recording: boolean }>;
	screenshot(): Promise<Screenshot>;
	act(action: Action & { settle_ms?: number }): Promise<Screenshot>;
	exec(req: ExecRequest): Promise<ExecResult & { pid?: number }>;
	/** Extract a tar archive into `destDir` inside the computer (entries keep the tar's ownership). */
	putArchive(tar: Buffer, destDir: string): Promise<void>;
	startRecording(path?: string): Promise<{ startedAt: number }>;
	stopRecording(): Promise<RecordingResult>;
	navigate(url: string, opts?: { timeoutMs?: number }): Promise<{ at: number; url: string; status: number | null; error?: string }>;
	pageSnapshot(opts?: { maxText?: number }): Promise<PageSnapshot>;
	consoleMessages(): Promise<ConsoleMessage[]>;
	networkEvents(): Promise<NetworkEvent[]>;
	logs(file: string, tail?: number): Promise<string>;
	/** Start a sibling service container on the run network, reachable at `name`. */
	startService(name: string, spec: ServiceSpec): Promise<void>;
	destroy(): Promise<void>;
}

export interface ComputerProvider {
	create(spec: ComputerSpec): Promise<Computer>;
	/** Remove computers and networks left behind by crashed runs. */
	cleanupOrphans(): Promise<number>;
}
