#!/usr/bin/env node
// Control server of the computer. Bearer-token HTTP on :7070.
//   GET  /health                      no auth; {ok, display, recording, browser}
//   POST /screenshot                  -> image/png; X-Cursor-X/Y, X-At headers
//   POST /act {type, ...}             xdotool action, then a fresh screenshot (as /screenshot)
//   POST /exec {cmd, timeout_ms, max_bytes, cwd, background, log}
//   POST /record/start {path}         ffmpeg x11grab -> .mkv
//   POST /record/stop                 SIGINT ffmpeg, remux to .mp4; {t0, duration, mkv, mp4}
//   POST /browser/navigate {url}      via CDP (the visible, recorded window)
//   POST /browser/snapshot            visible text + interactive elements in screen pixels
//   POST /browser/console             console messages + page errors since the last call
//   POST /browser/network             failed requests and >=400 responses since the last call
//   GET  /logs?file=app.log&tail=200  tail of a file under /artifacts
// Owns Chromium and ffmpeg: on SIGTERM it finalises the recording, then exits.
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { openSync, closeSync, existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright-core";

const run = promisify(execFile);
const PORT = Number(process.env.CONTROL_PORT ?? 7070);
const TOKEN = process.env.CONTROL_TOKEN ?? "";
const ARTIFACTS = "/artifacts";
const W = Number(process.env.SCREEN_WIDTH ?? 1920);
const H = Number(process.env.SCREEN_HEIGHT ?? 1080);
const CDP = "http://127.0.0.1:9222";
const SETTLE_MS = Number(process.env.ACT_SETTLE_MS ?? 300);

if (!TOKEN) {
	console.error("CONTROL_TOKEN is required");
	process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Chromium ----------

const CHROME_FLAGS = [
	"--no-first-run",
	"--no-default-browser-check",
	"--disable-dev-shm-usage",
	"--password-store=basic",
	"--remote-debugging-address=127.0.0.1",
	"--remote-debugging-port=9222",
	"--user-data-dir=/tmp/chrome-profile",
	"--start-maximized",
	`--window-size=${W},${H}`,
	"--window-position=0,0",
	// The container is the sandbox: CapDrop ALL + no-new-privileges leave Chromium
	// no way to build its own. --test-type hides the "unsupported flag" infobar.
	"--no-sandbox",
	"--test-type",
	"--disable-gpu",
	"--hide-crash-restore-bubble",
	"--disable-features=Translate,MediaRouter",
];

let chrome = null;
let stopping = false;

function launchChrome() {
	const url = process.env.START_URL ?? "about:blank";
	chrome = spawn("chromium", [...CHROME_FLAGS, url], {
		stdio: ["ignore", openSync("/tmp/computer-logs/chromium.log", "a"), openSync("/tmp/computer-logs/chromium.log", "a")],
		env: process.env,
	});
	log("chromium started", chrome.pid);
	chrome.on("exit", (code, sig) => {
		log("chromium exited", code, sig);
		browser = null;
		if (!stopping) setTimeout(launchChrome, 500);
	});
}

// ---------- CDP (Playwright) ----------

let browser = null;
let connecting = null;
const consoleBuf = [];
const networkBuf = [];
const MAX_BUF = 500;
const push = (buf, item) => {
	buf.push(item);
	if (buf.length > MAX_BUF) buf.shift();
};

function watchPage(page) {
	if (page.__acvWatched) return;
	page.__acvWatched = true;
	page.on("console", (m) =>
		push(consoleBuf, { at: Date.now(), type: m.type(), text: m.text().slice(0, 2000), url: page.url() })
	);
	page.on("pageerror", (e) => push(consoleBuf, { at: Date.now(), type: "pageerror", text: String(e?.stack ?? e).slice(0, 4000), url: page.url() }));
	page.on("requestfailed", (r) =>
		push(networkBuf, { at: Date.now(), kind: "failed", method: r.method(), url: r.url().slice(0, 500), error: r.failure()?.errorText })
	);
	page.on("response", (r) => {
		if (r.status() >= 400) push(networkBuf, { at: Date.now(), kind: "status", method: r.request().method(), url: r.url().slice(0, 500), status: r.status() });
	});
}

async function getBrowser() {
	if (browser?.isConnected()) return browser;
	if (connecting) return connecting;
	connecting = (async () => {
		let lastErr;
		for (let i = 0; i < 60; i++) {
			try {
				const b = await chromium.connectOverCDP(CDP, { timeout: 5000 });
				b.on("disconnected", () => (browser = null));
				for (const ctx of b.contexts()) {
					ctx.on("page", watchPage);
					ctx.pages().forEach(watchPage);
				}
				browser = b;
				return b;
			} catch (e) {
				lastErr = e;
				await sleep(250);
			}
		}
		throw lastErr;
	})().finally(() => (connecting = null));
	return connecting;
}

// The tab the user sees: the last non-devtools page whose document is visible.
async function activePage() {
	const b = await getBrowser();
	const pages = b.contexts().flatMap((c) => c.pages()).filter((p) => !p.url().startsWith("devtools://"));
	if (pages.length === 0) {
		const ctx = b.contexts()[0] ?? (await b.newContext());
		const p = await ctx.newPage();
		watchPage(p);
		return p;
	}
	for (const p of [...pages].reverse()) {
		const vis = await p.evaluate(() => document.visibilityState).catch(() => "hidden");
		if (vis === "visible") return p;
	}
	return pages.at(-1);
}

// Visible text plus interactive elements, with centres in screen pixels. Refs index
// window.__acvRefs (no DOM mutation) and stay valid until the next snapshot.
const SNAPSHOT_FN = (maxText) => {
	const ox = window.screenX + (window.outerWidth - window.innerWidth) / 2;
	const oy = window.screenY + (window.outerHeight - window.innerHeight);
	const sel = "a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[role=switch],[role=option],[contenteditable=''],[contenteditable=true],[tabindex]:not([tabindex='-1'])";
	const refs = [];
	const elements = [];
	for (const el of document.querySelectorAll(sel)) {
		const r = el.getBoundingClientRect();
		if (r.width < 1 || r.height < 1) continue;
		if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) continue;
		const st = getComputedStyle(el);
		if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) === 0) continue;
		const name = (el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || "").trim().replace(/\s+/g, " ").slice(0, 120);
		const ref = refs.push(el) - 1;
		elements.push({
			ref: `e${ref}`,
			tag: el.tagName.toLowerCase(),
			role: el.getAttribute("role") || undefined,
			type: el.getAttribute("type") || undefined,
			name,
			value: el.type === "password" ? (el.value ? "••••" : "") : el.value !== undefined && el.tagName !== "BUTTON" ? String(el.value).slice(0, 120) : undefined,
			checked: el.checked ?? undefined,
			disabled: el.disabled || el.getAttribute("aria-disabled") === "true" || undefined,
			x: Math.round(ox + r.left + r.width / 2),
			y: Math.round(oy + r.top + r.height / 2),
			w: Math.round(r.width),
			h: Math.round(r.height),
		});
	}
	window.__acvRefs = refs;
	const text = (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").slice(0, maxText);
	return { url: location.href, title: document.title, viewport: { x: ox, y: oy, w: window.innerWidth, h: window.innerHeight }, text, elements };
};

// ---------- recording ----------

let rec = null; // {proc, mkv, startedAt, exited}

function startRecording(path) {
	if (rec) throw httpError(409, "already recording");
	const mkv = safeArtifactPath(path ?? "raw.mkv");
	const args = [
		"-hide_banner", "-loglevel", "error", "-nostdin",
		"-f", "x11grab", "-draw_mouse", "0", "-framerate", "30", "-video_size", `${W}x${H}`, "-i", ":1",
		// Keep x11grab's wall-clock pts so the first frame's capture time is exact (t0).
		"-copyts",
		"-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p",
		"-y", mkv,
	];
	const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", openSync("/tmp/computer-logs/ffmpeg.log", "a")] });
	rec = { proc, mkv, startedAt: Date.now() };
	proc.on("exit", (code, sig) => {
		log("ffmpeg exited", code, sig);
		if (rec?.proc === proc) rec.exited = true;
	});
	return { mkv, startedAt: rec.startedAt };
}

async function stopRecording() {
	if (!rec) throw httpError(409, "not recording");
	const { proc, mkv } = rec;
	if (!rec.exited) {
		const exited = new Promise((r) => proc.once("exit", r));
		proc.kill("SIGINT");
		const t = await Promise.race([exited.then(() => "ok"), sleep(5000).then(() => "timeout")]);
		if (t === "timeout") {
			log("ffmpeg ignored SIGINT for 5s; killing");
			proc.kill("SIGKILL");
			await exited;
		}
	}
	rec = null;
	// The first packet's pts is the capture wall time in seconds (x11grab + -copyts).
	const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-read_intervals", "%+#1", "-of", "csv=p=0", mkv]);
	const firstPts = Number.parseFloat(stdout.trim().split("\n")[0]);
	const t0 = Number.isFinite(firstPts) && firstPts > 1e9 ? Math.round(firstPts * 1000) : null;
	const mp4 = mkv.replace(/\.mkv$/, ".mp4");
	await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", mkv, "-c", "copy", "-movflags", "+faststart", mp4]);
	const { stdout: d } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4]);
	return { t0, duration: Number.parseFloat(d), mkv, mp4 };
}

// ---------- screenshot + actions ----------

async function cursor() {
	const { stdout } = await run("xdotool", ["getmouselocation", "--shell"]);
	const x = Number(stdout.match(/X=(\d+)/)?.[1] ?? 0);
	const y = Number(stdout.match(/Y=(\d+)/)?.[1] ?? 0);
	return { x, y };
}

async function screenshot() {
	const { stdout } = await run("import", ["-display", ":1", "-window", "root", "png:-"], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
	return stdout;
}

const xdo = (...args) => run("xdotool", args.map(String));
const int = (v, name) => {
	const n = Math.round(Number(v));
	if (!Number.isFinite(n)) throw httpError(400, `${name} must be a number`);
	return n;
};
const clampX = (v) => Math.max(0, Math.min(W - 1, int(v, "x")));
const clampY = (v) => Math.max(0, Math.min(H - 1, int(v, "y")));

async function act(a) {
	switch (a.type) {
		case "move":
			return xdo("mousemove", clampX(a.x), clampY(a.y));
		case "click":
		case "double_click":
		case "right_click": {
			const button = a.type === "right_click" ? 3 : a.button === "middle" ? 2 : 1;
			const repeat = a.type === "double_click" ? ["--repeat", 2, "--delay", 80] : [];
			return xdo("mousemove", clampX(a.x), clampY(a.y), "click", ...repeat, button);
		}
		case "drag": {
			const [x1, y1, x2, y2] = [clampX(a.x), clampY(a.y), clampX(a.to_x), clampY(a.to_y)];
			await xdo("mousemove", x1, y1, "mousedown", 1);
			const steps = 15;
			for (let i = 1; i <= steps; i++) {
				await xdo("mousemove", Math.round(x1 + ((x2 - x1) * i) / steps), Math.round(y1 + ((y2 - y1) * i) / steps));
				await sleep(16);
			}
			return xdo("mouseup", 1);
		}
		case "type":
			if (typeof a.text !== "string") throw httpError(400, "text required");
			return xdo("type", "--delay", a.delay_ms ?? 18, "--", a.text);
		case "key":
			if (typeof a.combo !== "string") throw httpError(400, "combo required");
			return xdo("key", "--clearmodifiers", "--", ...a.combo.split(/\s+/));
		case "scroll": {
			if (a.x != null && a.y != null) await xdo("mousemove", clampX(a.x), clampY(a.y));
			const dy = int(a.dy ?? 0, "dy");
			const dx = int(a.dx ?? 0, "dx");
			if (dy) await xdo("click", "--repeat", Math.min(50, Math.abs(dy)), "--delay", 30, dy > 0 ? 5 : 4);
			if (dx) await xdo("click", "--repeat", Math.min(50, Math.abs(dx)), "--delay", 30, dx > 0 ? 7 : 6);
			return;
		}
		case "wait":
			return sleep(Math.min(30_000, int(a.ms ?? 1000, "ms")));
		default:
			throw httpError(400, `unknown action type: ${a.type}`);
	}
}

// ---------- exec ----------

function exec({ cmd, timeout_ms = 30_000, max_bytes = 1_000_000, cwd = "/home/qa", background = false, log: logFile }) {
	if (typeof cmd !== "string" || !cmd) throw httpError(400, "cmd required");
	if (background) {
		const out = logFile ? openSync(safeArtifactPath(logFile), "a") : "ignore";
		const p = spawn("bash", ["-lc", cmd], { cwd, detached: true, stdio: ["ignore", out, out], env: process.env });
		p.unref();
		if (typeof out === "number") closeSync(out);
		return Promise.resolve({ pid: p.pid });
	}
	return new Promise((resolveExec) => {
		const p = spawn("bash", ["-lc", cmd], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env: process.env });
		const chunks = { stdout: [], stderr: [] };
		const size = { stdout: 0, stderr: 0 };
		let truncated = false;
		for (const k of ["stdout", "stderr"]) {
			p[k].on("data", (d) => {
				if (size[k] >= max_bytes) return (truncated = true);
				const take = d.subarray(0, max_bytes - size[k]);
				if (take.length < d.length) truncated = true;
				size[k] += take.length;
				chunks[k].push(take);
			});
		}
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try { process.kill(-p.pid, "SIGKILL"); } catch {}
		}, timeout_ms);
		p.on("close", (code, signal) => {
			clearTimeout(timer);
			resolveExec({
				code,
				signal,
				timed_out: timedOut,
				truncated,
				stdout: Buffer.concat(chunks.stdout).toString("utf8"),
				stderr: Buffer.concat(chunks.stderr).toString("utf8"),
			});
		});
	});
}

// ---------- HTTP ----------

function httpError(status, message) {
	return Object.assign(new Error(message), { status });
}

function safeArtifactPath(p) {
	const abs = resolve(ARTIFACTS, String(p));
	if (abs !== ARTIFACTS && !abs.startsWith(ARTIFACTS + "/")) throw httpError(400, "path must be under /artifacts");
	return abs;
}

function readBody(req) {
	return new Promise((res, rej) => {
		let size = 0;
		const chunks = [];
		req.on("data", (c) => {
			size += c.length;
			if (size > 2_000_000) {
				rej(httpError(413, "body too large"));
				req.destroy();
			} else chunks.push(c);
		});
		req.on("end", () => {
			const s = Buffer.concat(chunks).toString("utf8");
			try {
				res(s ? JSON.parse(s) : {});
			} catch {
				rej(httpError(400, "invalid JSON"));
			}
		});
		req.on("error", rej);
	});
}

const json = (res, status, body) => {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
};

async function sendScreenshot(res, extra = {}) {
	const [png, c] = await Promise.all([screenshot(), cursor()]);
	res.writeHead(200, {
		"content-type": "image/png",
		"x-cursor-x": c.x,
		"x-cursor-y": c.y,
		"x-at": Date.now(),
		...Object.fromEntries(Object.entries(extra).map(([k, v]) => [`x-${k}`, String(v)])),
	});
	res.end(png);
}

const drain = (buf) => buf.splice(0, buf.length);

const routes = {
	"POST /screenshot": (_req, res) => sendScreenshot(res),
	"POST /act": async (_req, res, body) => {
		const at = Date.now();
		await act(body);
		if (body.type !== "wait") await sleep(body.settle_ms ?? SETTLE_MS);
		if (body.screenshot === false) return json(res, 200, { at, cursor: await cursor() });
		return sendScreenshot(res, { "action-at": at });
	},
	"POST /exec": async (_req, res, body) => json(res, 200, await exec(body)),
	"POST /record/start": async (_req, res, body) => json(res, 200, startRecording(body.path)),
	"POST /record/stop": async (_req, res) => json(res, 200, await stopRecording()),
	"POST /browser/navigate": async (_req, res, body) => {
		if (typeof body.url !== "string") throw httpError(400, "url required");
		const page = await activePage();
		const at = Date.now();
		const r = await page.goto(body.url, { waitUntil: body.wait_until ?? "load", timeout: body.timeout_ms ?? 30_000 }).catch((e) => ({ error: String(e.message ?? e) }));
		json(res, 200, { at, url: page.url(), status: r?.status?.() ?? null, error: r?.error });
	},
	"POST /browser/snapshot": async (_req, res, body) => {
		const page = await activePage();
		json(res, 200, await page.evaluate(SNAPSHOT_FN, body.max_text ?? 6000));
	},
	"POST /browser/console": async (_req, res) => {
		await getBrowser();
		json(res, 200, { messages: drain(consoleBuf) });
	},
	"POST /browser/network": async (_req, res) => {
		await getBrowser();
		json(res, 200, { requests: drain(networkBuf) });
	},
	"GET /logs": async (_req, res, body, url) => {
		const file = safeArtifactPath(url.searchParams.get("file") ?? "app.log");
		const tail = Math.min(5000, Number(url.searchParams.get("tail") ?? 200));
		if (!existsSync(file)) return json(res, 404, { error: "no such file" });
		const st = statSync(file);
		const start = Math.max(0, st.size - 2_000_000);
		const text = readFileSync(file).subarray(start).toString("utf8");
		json(res, 200, { file, lines: text.split("\n").slice(-tail).join("\n") });
	},
};

const server = createServer(async (req, res) => {
	const url = new URL(req.url, "http://x");
	try {
		if (req.method === "GET" && url.pathname === "/health") {
			const ok = await run("xdpyinfo", ["-display", ":1"]).then(() => true, () => false);
			return json(res, ok ? 200 : 503, { ok, display: ":1", size: { w: W, h: H }, recording: !!rec, browser: !!browser?.isConnected() });
		}
		if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, { error: "unauthorized" });
		const handler = routes[`${req.method} ${url.pathname}`];
		if (!handler) return json(res, 404, { error: "not found" });
		const body = req.method === "POST" ? await readBody(req) : {};
		await handler(req, res, body, url);
	} catch (e) {
		log("error", req.method, url.pathname, e.stack ?? e);
		if (!res.headersSent) json(res, e.status ?? 500, { error: String(e.message ?? e) });
		else res.end();
	}
});

async function shutdown(sig) {
	if (stopping) return;
	stopping = true;
	log("shutdown", sig);
	try {
		if (rec) await Promise.race([stopRecording(), sleep(2000)]);
	} catch (e) {
		log("stopRecording on shutdown failed", e.message);
	}
	chrome?.kill("SIGTERM");
	server.close();
	process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

launchChrome();
server.listen(PORT, "0.0.0.0", () => log(`control listening on :${PORT}`));
