import type {
	Action,
	ConsoleMessage,
	ExecRequest,
	ExecResult,
	NetworkEvent,
	PageSnapshot,
	RecordingResult,
	Screenshot,
} from "./types.ts";

/** HTTP client for the computer's control server (infra/computer/control). */
export class ControlClient {
	constructor(
		readonly baseUrl: string,
		private readonly token: string
	) {}

	private async req(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<Response> {
		const res = await fetch(`${this.baseUrl}${path}`, {
			method,
			headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`control ${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
		}
		return res;
	}

	private async json<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
		return (await this.req(method, path, body ?? {}, timeoutMs)).json() as Promise<T>;
	}

	private static async toScreenshot(res: Response): Promise<Screenshot> {
		const h = res.headers;
		const actionAt = h.get("x-action-at");
		return {
			png: Buffer.from(await res.arrayBuffer()),
			cursor: { x: Number(h.get("x-cursor-x")), y: Number(h.get("x-cursor-y")) },
			at: Number(h.get("x-at")),
			actionAt: actionAt ? Number(actionAt) : undefined,
		};
	}

	async health(): Promise<{ ok: boolean; browser: boolean; recording: boolean }> {
		const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
		return res.json() as Promise<{ ok: boolean; browser: boolean; recording: boolean }>;
	}

	async screenshot(): Promise<Screenshot> {
		return ControlClient.toScreenshot(await this.req("POST", "/screenshot", {}));
	}

	async act(action: Action & { settle_ms?: number }): Promise<Screenshot> {
		const timeout = action.type === "wait" ? action.ms + 30_000 : 60_000;
		return ControlClient.toScreenshot(await this.req("POST", "/act", action, timeout));
	}

	exec(r: ExecRequest): Promise<ExecResult & { pid?: number }> {
		return this.json(
			"POST",
			"/exec",
			{ cmd: r.cmd, timeout_ms: r.timeoutMs, max_bytes: r.maxBytes, cwd: r.cwd, background: r.background, log: r.log },
			(r.timeoutMs ?? 30_000) + 10_000
		);
	}

	startRecording(path?: string): Promise<{ startedAt: number }> {
		return this.json("POST", "/record/start", { path });
	}

	stopRecording(): Promise<RecordingResult> {
		return this.json("POST", "/record/stop", {}, 120_000);
	}

	navigate(url: string, timeoutMs = 30_000) {
		return this.json<{ at: number; url: string; status: number | null; error?: string }>(
			"POST",
			"/browser/navigate",
			{ url, timeout_ms: timeoutMs },
			timeoutMs + 10_000
		);
	}

	pageSnapshot(maxText?: number): Promise<PageSnapshot> {
		return this.json("POST", "/browser/snapshot", { max_text: maxText });
	}

	async consoleMessages(): Promise<ConsoleMessage[]> {
		return (await this.json<{ messages: ConsoleMessage[] }>("POST", "/browser/console")).messages;
	}

	async networkEvents(): Promise<NetworkEvent[]> {
		return (await this.json<{ requests: NetworkEvent[] }>("POST", "/browser/network")).requests;
	}

	async logs(file: string, tail = 200): Promise<string> {
		const q = new URLSearchParams({ file, tail: String(tail) });
		const res = await fetch(`${this.baseUrl}/logs?${q}`, { headers: { authorization: `Bearer ${this.token}` } });
		if (res.status === 404) return "";
		if (!res.ok) throw new Error(`control GET /logs -> ${res.status}`);
		return ((await res.json()) as { lines: string }).lines;
	}
}
