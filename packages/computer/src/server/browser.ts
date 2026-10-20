// Chromium (supervised child process) and CDP access to the visible tab.
import { Config, Context, Duration, Effect, Layer, Schedule, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { Browser as PwBrowser, Page } from "playwright-core"
import { chromium } from "playwright-core"
import { PageSnapshot, type ConsoleMessage, type NavigateResult, type NetworkEvent } from "../protocol.ts"
import { BrowserError } from "./errors.ts"

const CHROME_FLAGS = (w: number, h: number) => [
	"--no-first-run",
	"--no-default-browser-check",
	"--disable-dev-shm-usage",
	"--password-store=basic",
	"--remote-debugging-address=127.0.0.1",
	"--remote-debugging-port=9222",
	"--user-data-dir=/tmp/chrome-profile",
	"--start-maximized",
	`--window-size=${w},${h}`,
	"--window-position=0,0",
	// The container is the sandbox: CapDrop ALL + no-new-privileges leave Chromium
	// no way to build its own. --test-type hides the "unsupported flag" infobar.
	"--no-sandbox",
	"--test-type",
	"--disable-gpu",
	"--hide-crash-restore-bubble",
	"--disable-features=Translate,MediaRouter",
]

/** Environment for children: everything but the control token. */
export const childEnv = (): Record<string, string> =>
	Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[0] !== "CONTROL_TOKEN" && typeof e[1] === "string"))

/** Keeps Chromium running for the server's lifetime; killed with the server's scope. */
export const ChromeLive = Layer.effectDiscard(
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const w = yield* Config.Int("SCREEN_WIDTH").pipe(Config.withDefault(1920))
		const h = yield* Config.Int("SCREEN_HEIGHT").pipe(Config.withDefault(1080))
		const startUrl = yield* Config.String("START_URL").pipe(Config.withDefault("about:blank"))
		const once = Effect.gen(function* () {
			const handle = yield* spawner.spawn(
				ChildProcess.make("chromium", [...CHROME_FLAGS(w, h), startUrl], { env: childEnv(), extendEnv: false, stdin: "ignore", stdout: "ignore", stderr: "ignore" })
			)
			yield* Effect.logInfo("chromium started", { pid: handle.pid })
			const code = yield* handle.exitCode
			yield* Effect.logWarning("chromium exited", { code })
		}).pipe(Effect.scoped, Effect.catchCause((cause) => Effect.logError("chromium failed", cause)))
		yield* once.pipe(Effect.repeat(Schedule.spaced("500 millis")), Effect.forkScoped)
	})
)

// Visible text plus interactive elements, centres in screen pixels. Refs index
// window.__witnessRefs (no DOM mutation) and stay valid until the next snapshot.
const SNAPSHOT_FN = (maxText: number) => {
	const ox = window.screenX + (window.outerWidth - window.innerWidth) / 2
	const oy = window.screenY + (window.outerHeight - window.innerHeight)
	const sel =
		"a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[role=switch],[role=option],[contenteditable=''],[contenteditable=true],[tabindex]:not([tabindex='-1'])"
	const refs: Array<Element> = []
	const elements: Array<Record<string, unknown>> = []
	for (const el of Array.from(document.querySelectorAll(sel))) {
		const r = el.getBoundingClientRect()
		if (r.width < 1 || r.height < 1) continue
		if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) continue
		const st = getComputedStyle(el)
		if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) === 0) continue
		const h = el as HTMLInputElement
		const name = (el.getAttribute("aria-label") || (el as HTMLElement).innerText || h.value || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || "")
			.trim()
			.replace(/\s+/g, " ")
			.slice(0, 120)
		const ref = refs.push(el) - 1
		const e: Record<string, unknown> = { ref: `e${ref}`, tag: el.tagName.toLowerCase(), name, x: Math.round(ox + r.left + r.width / 2), y: Math.round(oy + r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) }
		const role = el.getAttribute("role")
		if (role) e.role = role
		const type = el.getAttribute("type")
		if (type) e.type = type
		if (h.value !== undefined && el.tagName !== "BUTTON") e.value = h.type === "password" ? (h.value ? "••••" : "") : String(h.value).slice(0, 120)
		if (h.checked) e.checked = true
		if (h.disabled || el.getAttribute("aria-disabled") === "true") e.disabled = true
		elements.push(e)
	}
	;(window as unknown as { __witnessRefs: Array<Element> }).__witnessRefs = refs
	const text = (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").slice(0, maxText)
	return { url: location.href, title: document.title, viewport: { x: ox, y: oy, w: window.innerWidth, h: window.innerHeight }, text, elements }
}

const MAX_BUF = 500
const decodeSnapshot = Schema.decodeUnknownEffect(PageSnapshot)

export class Browser extends Context.Service<
	Browser,
	{
		navigate(url: string, timeoutMs: number): Effect.Effect<NavigateResult, BrowserError>
		snapshot(maxText: number): Effect.Effect<PageSnapshot, BrowserError>
		evaluate(expression: string): Effect.Effect<unknown, BrowserError>
		/** Console messages and page errors since the last call. */
		readonly drainConsole: Effect.Effect<ReadonlyArray<ConsoleMessage>, BrowserError>
		/** Failed requests and >= 400 responses since the last call. */
		readonly drainNetwork: Effect.Effect<ReadonlyArray<NetworkEvent>, BrowserError>
		readonly connected: Effect.Effect<boolean>
	}
>()("witness/computer/server/Browser") {
	static readonly layer = Layer.effect(
		Browser,
		Effect.gen(function* () {
			// Event buffers are filled by Playwright callbacks (outside Effect) and drained by requests.
			const consoleBuf: Array<ConsoleMessage> = []
			const networkBuf: Array<NetworkEvent> = []
			const push = <A>(buf: Array<A>, item: A) => {
				buf.push(item)
				if (buf.length > MAX_BUF) buf.shift()
			}
			const watched = new WeakSet<Page>()
			const watch = (page: Page) => {
				if (watched.has(page)) return
				watched.add(page)
				page.on("console", (m) => push(consoleBuf, { at: Date.now(), type: m.type(), text: m.text().slice(0, 2000), url: page.url() }))
				page.on("pageerror", (e) => push(consoleBuf, { at: Date.now(), type: "pageerror", text: String(e.stack ?? e).slice(0, 4000), url: page.url() }))
				page.on("requestfailed", (r) => {
					const ev: NetworkEvent = { at: Date.now(), kind: "failed", method: r.method(), url: r.url().slice(0, 500) }
					const error = r.failure()?.errorText
					push(networkBuf, error ? { ...ev, error } : ev)
				})
				page.on("response", (r) => {
					if (r.status() >= 400) push(networkBuf, { at: Date.now(), kind: "status", method: r.request().method(), url: r.url().slice(0, 500), status: r.status() })
				})
			}

			let current: PwBrowser | undefined
			const fail = (what: string) => (e: unknown) => new BrowserError({ message: `${what}: ${e instanceof Error ? e.message : String(e)}` })

			const connect = Effect.tryPromise({
				try: () => chromium.connectOverCDP("http://127.0.0.1:9222", { timeout: 5000 }),
				catch: fail("connect"),
			}).pipe(
				Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 60 }),
				Effect.tap((b) =>
					Effect.sync(() => {
						b.on("disconnected", () => {
							if (current === b) current = undefined
						})
						for (const ctx of b.contexts()) {
							ctx.on("page", watch)
							ctx.pages().forEach(watch)
						}
						current = b
					})
				)
			)
			const browser = Effect.suspend(() => (current?.isConnected() ? Effect.succeed(current) : connect))

			// The tab the user sees: the last non-devtools page whose document is visible.
			const activePage = Effect.gen(function* () {
				const b = yield* browser
				const pages = b.contexts().flatMap((c) => c.pages()).filter((p) => !p.url().startsWith("devtools://"))
				if (pages.length === 0) {
					const ctx = b.contexts()[0]
					const page = yield* Effect.tryPromise({ try: () => (ctx ? ctx.newPage() : b.newPage()), catch: fail("newPage") })
					watch(page)
					return page
				}
				for (const p of [...pages].reverse()) {
					const vis = yield* Effect.tryPromise({ try: () => p.evaluate(() => document.visibilityState), catch: fail("visibility") }).pipe(Effect.orElseSucceed(() => "hidden"))
					if (vis === "visible") return p
				}
				return pages[pages.length - 1]!
			})

			const navigate = Effect.fn("Browser.navigate")(function* (url: string, timeoutMs: number) {
				const page = yield* activePage
				const at = Date.now()
				return yield* Effect.tryPromise({ try: () => page.goto(url, { waitUntil: "load", timeout: timeoutMs }), catch: fail("goto") }).pipe(
					Effect.map((r): NavigateResult => ({ at, url: page.url(), status: r?.status() ?? null })),
					Effect.catchTag("BrowserError", (e) => Effect.succeed<NavigateResult>({ at, url: page.url(), status: null, error: e.message }))
				)
			})

			const snapshot = Effect.fn("Browser.snapshot")(function* (maxText: number) {
				const page = yield* activePage
				const raw = yield* Effect.tryPromise({ try: () => page.evaluate(SNAPSHOT_FN, maxText), catch: fail("snapshot") })
				// Page data is untrusted: validate it rather than cast it.
				return yield* decodeSnapshot(raw).pipe(Effect.mapError((e) => new BrowserError({ message: `snapshot: ${e.message}` })))
			})

			const evaluate = Effect.fn("Browser.evaluate")(function* (expression: string) {
				const page = yield* activePage
				return yield* Effect.tryPromise({ try: () => page.evaluate(expression), catch: fail("evaluate") })
			})

			const drain = <A>(buf: Array<A>) => browser.pipe(Effect.map(() => buf.splice(0, buf.length)))

			// Connect in the background so the first request does not pay for it.
			yield* browser.pipe(Effect.timeoutOption(Duration.seconds(30)), Effect.ignore, Effect.forkScoped)

			return Browser.of({
				navigate,
				snapshot,
				evaluate,
				drainConsole: drain(consoleBuf),
				drainNetwork: drain(networkBuf),
				connected: Effect.sync(() => current?.isConnected() ?? false),
			})
		})
	)
}

