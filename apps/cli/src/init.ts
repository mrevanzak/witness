// `witness init`: draft a witness.yaml from what the repo already declares
// (lockfile, package scripts, Playwright's webServer, docker compose,
// .env.example). The draft is a starting point; `witness run --boot-only`
// proves it. It also asks where published evidence goes (`evidence`) and
// gitignores `.witness/`, where runs are recorded.
import { type EvidenceDestination, parseEnvFile, parseWitnessConfig } from "@witness/domain"
import { Config, Console, Effect, FileSystem, Option, Path, Schema } from "effect"
import { Prompt } from "effect/cli"
import { parse, stringify } from "yaml"
import { ignoreWitnessDir } from "./runs.ts"

export class InitError extends Schema.TaggedError<InitError>()("InitError", { message: Schema.String }) {}

export type PackageManager = "pnpm" | "yarn" | "yarn-berry" | "npm" | "bun"

export type ComposeService = {
	readonly env: Record<string, string>
	readonly image: string
	readonly port: number | undefined
}

/** What the repo tells us about how it runs. Gathered by `readFacts`, consumed by `draftConfig`. */
export type RepoFacts = {
	readonly compose: Record<string, ComposeService>
	readonly deps: readonly string[]
	readonly envExample: Record<string, string>
	readonly packageManager: PackageManager | undefined
	readonly scripts: Record<string, string>
	readonly webServer:
		| { readonly command: string; readonly url: string | undefined; readonly port: number | undefined }
		| undefined
}

export type Draft = {
	readonly config: Record<string, unknown>
	/** What was guessed and what to check, one line each. */
	readonly notes: readonly string[]
}

const INSTALL: Record<PackageManager, string> = {
	bun: "bun install --frozen-lockfile",
	npm: "npm ci",
	pnpm: "pnpm install --frozen-lockfile",
	yarn: "yarn install --frozen-lockfile",
	"yarn-berry": "yarn install --immutable",
}

const runScript = (pm: PackageManager | undefined, script: string) => {
	switch (pm) {
		case "yarn":
		case "yarn-berry":
			return `yarn ${script}`
		case "bun":
			return `bun run ${script}`
		case "pnpm":
			return `pnpm run ${script}`
		case "npm":
		case undefined:
			return `npm run ${script}`
	}
}

/** Dev-server ports by framework package, most specific first. */
const FRAMEWORK_PORTS: ReadonlyArray<readonly [string, number]> = [
	["next", 3000],
	["nuxt", 3000],
	["@remix-run/dev", 3000],
	["astro", 4321],
	["@sveltejs/kit", 5173],
	["@react-router/dev", 5173],
	["@angular/cli", 4200],
	["gatsby", 8000],
	["react-scripts", 3000],
	["vite", 5173],
]

/** A port written in a command: `--port 4000`, `--port=4000`, `-p 4000`, `PORT=4000`. */
export const portInCommand = (command: string): number | undefined => {
	const m = command.match(/(?:--port[= ]|-p\s+|\bPORT=)(\d{2,5})\b/)
	return m ? Number(m[1]) : undefined
}

const portInUrl = (url: string): number | undefined => {
	const m = url.match(/^https?:\/\/[^/:]+:(\d+)/)
	return m ? Number(m[1]) : undefined
}

/** Images worth running next to the app; anything else in compose is probably the app itself. */
const SERVICE_IMAGE =
	/^(?:[\w.-]+\/)*(postgres|postgis|mysql|mariadb|redis|valkey|mongo|minio|mailhog|mailpit|rabbitmq|elasticsearch|opensearch|memcached|localstack|supabase\/postgres)\b/

/** Turns repo facts into a witness.yaml draft. Pure. */
export const draftConfig = (facts: RepoFacts): Draft => {
	const notes: string[] = []
	const pm = facts.packageManager
	const setup: string[] = []
	if (pm) {
		setup.push(INSTALL[pm])
	} else if (facts.deps.length) {
		setup.push("npm install")
		notes.push("No lockfile found, so `setup` uses `npm install`; pin it to your package manager's frozen install.")
	}

	// Start: Playwright's webServer is what the repo's own e2e tests boot, so it wins.
	let start: string | undefined
	let port: number | undefined
	if (facts.webServer) {
		start = facts.webServer.command
		port = facts.webServer.port ?? (facts.webServer.url ? portInUrl(facts.webServer.url) : undefined)
		notes.push("`start` comes from playwright.config webServer, the command the repo's e2e tests use.")
	} else {
		const script = ["dev", "start", "serve", "preview"].find((s) => facts.scripts[s] !== undefined)
		if (script) {
			start = runScript(pm, script)
			port = portInCommand(facts.scripts[script]!)
			notes.push(`\`start\` runs the "${script}" script (${facts.scripts[script]}).`)
		}
	}
	if (!start) {
		start = "echo 'set start: the command that serves the app' && exit 1"
		notes.push("No dev/start script found: set `start` to the command that serves the app.")
	}
	if (port === undefined) {
		const framework = FRAMEWORK_PORTS.find(([dep]) => facts.deps.includes(dep))
		if (framework) {
			port = framework[1]
			notes.push(`Port ${port} is ${framework[0]}'s default; change \`url\` if the app listens elsewhere.`)
		} else {
			port = 3000
			notes.push("Port 3000 is a guess: set `url` to where the app listens.")
		}
	}

	// Database steps the repo already scripts.
	for (const s of ["db:migrate", "migrate", "db:seed", "seed"]) {
		if (facts.scripts[s] !== undefined) {
			setup.push(runScript(pm, s))
		}
	}

	// Services from compose. Inside a run they're reachable by service name, not localhost.
	const services: Record<string, Record<string, unknown>> = {}
	const hostFor = new Map<number, string>()
	for (const [name, svc] of Object.entries(facts.compose)) {
		if (!SERVICE_IMAGE.test(svc.image)) {
			continue
		}
		const id =
			name
				.toLowerCase()
				.replace(/[^a-z0-9-]/g, "-")
				.replace(/^[^a-z]+/, "")
				.slice(0, 31) || "svc"
		services[id] = {
			image: svc.image,
			...(Object.keys(svc.env).length ? { env: svc.env } : {}),
			...(svc.port ? { port: svc.port } : {}),
		}
		if (svc.port) {
			hostFor.set(svc.port, id)
		}
	}
	if (Object.keys(services).length) {
		notes.push(
			`Services from docker compose: ${Object.keys(services).join(", ")}. Env pointing at localhost:<their port> now points at the service name.`
		)
	}

	// Env from .env.example, rewired to the services. Empty values are left for you to fill.
	const env: Record<string, string> = {}
	const empty: string[] = []
	for (const [k, v] of Object.entries(facts.envExample)) {
		if (v === "") {
			empty.push(k)
			continue
		}
		env[k] = v.replace(/\b(?:localhost|127\.0\.0\.1):(\d{2,5})\b/g, (all, p: string) => {
			const host = hostFor.get(Number(p))
			return host ? `${host}:${p}` : all
		})
	}
	if (empty.length) {
		notes.push(
			`.env.example leaves these empty, so they're not set: ${empty.join(", ")}. Add test values under \`env\`, or keep secrets in a file passed as \`secret_env\` from a --config outside the repo.`
		)
	}
	notes.push("If the app needs a signed-in user, add `login` with a seeded test account.")

	// Most Node servers read PORT; it is harmless for the ones that don't.
	if (portInCommand(start) === undefined && !("PORT" in env)) {
		env.PORT = String(port)
	}

	const url = `http://localhost:${port}`
	const config: Record<string, unknown> = {
		setup,
		start,
		url,
		...(Object.keys(services).length ? { services } : {}),
		...(Object.keys(env).length ? { env } : {}),
	}
	return { config, notes }
}

/** The YAML text for a draft, notes as a comment header. */
export const renderDraft = (draft: Draft): string =>
	[
		"# How Witness boots this app. Drafted by `witness init`; check the notes, then prove it with `witness run --boot-only`.",
		...draft.notes.map((n) => `# - ${n}`),
		"",
		stringify(draft.config, { lineWidth: 0 }).trimEnd(),
		"",
	].join("\n")

/** Lockfiles in the order they're checked; Yarn Berry is told apart by `.yarnrc.yml`. */
const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
	["pnpm-lock.yaml", "pnpm"],
	["bun.lock", "bun"],
	["bun.lockb", "bun"],
	["yarn.lock", "yarn"],
	["package-lock.json", "npm"],
]

const PackageJson = Schema.Struct({
	dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
	devDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
	packageManager: Schema.optionalKey(Schema.String),
	scripts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
})

/** Reads Playwright's `webServer` out of its config source. Good enough for the common literal form. */
export const webServerIn = (source: string): RepoFacts["webServer"] => {
	const block = source.match(/webServer\s*:\s*\[?\s*\{([\s\S]*?)\}/)
	if (!block) {
		return undefined
	}
	const str = (key: string) => block[1]!.match(new RegExp(`${key}\\s*:\\s*(['"\`])(.*?)\\1`))?.[2]
	const command = str("command")
	if (!command) {
		return undefined
	}
	const portLit = block[1]!.match(/port\s*:\s*(\d{2,5})/)
	return { command, port: portLit ? Number(portLit[1]) : undefined, url: str("url") }
}

/** Reads compose services: image, first container port, environment. */
export const composeServices = (text: string): Record<string, ComposeService> => {
	const doc = parse(text) as {
		services?: Record<string, { image?: unknown; ports?: unknown; environment?: unknown }>
	} | null
	const out: Record<string, ComposeService> = {}
	for (const [name, s] of Object.entries(doc?.services ?? {})) {
		if (typeof s?.image !== "string") {
			continue
		}
		const first = Array.isArray(s.ports) ? String(s.ports[0] ?? "") : ""
		const port = Number(first.split(":").pop()?.split("/")[0]) || undefined
		const env: Record<string, string> = {}
		if (Array.isArray(s.environment)) {
			for (const e of s.environment) {
				const [k, ...v] = String(e).split("=")
				if (k && v.length) {
					env[k] = v.join("=")
				}
			}
		} else if (s.environment && typeof s.environment === "object") {
			for (const [k, v] of Object.entries(s.environment)) {
				if (v !== null && v !== undefined) {
					env[k] = String(v)
				}
			}
		}
		out[name] = { env, image: s.image, port }
	}
	return out
}

/** Gathers facts from the files in `dir`. */
export const readFacts = Effect.fn("readFacts")(function* (dir: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const read = (name: string) =>
		fs
			.exists(path.join(dir, name))
			.pipe(
				Effect.flatMap((ok) =>
					ok
						? fs.readFileString(path.join(dir, name)).pipe(Effect.map(Option.some))
						: Effect.succeed(Option.none<string>())
				)
			)
	const firstOf = (names: readonly string[]) =>
		Effect.findFirst(names, (n) => fs.exists(path.join(dir, n))).pipe(
			Effect.flatMap(Option.match({ onNone: () => Effect.succeed(Option.none<string>()), onSome: read }))
		)

	const pkg = Option.flatMap(yield* read("package.json"), (t) =>
		Option.flatMap(Option.liftThrowable(JSON.parse)(t), Schema.decodeUnknownOption(PackageJson))
	)
	const lockfile = yield* Effect.findFirst(LOCKFILES, ([file]) => fs.exists(path.join(dir, file)))
	let packageManager = Option.getOrUndefined(Option.map(lockfile, ([, pm]) => pm))
	if (packageManager === "yarn" && (yield* fs.exists(path.join(dir, ".yarnrc.yml")))) {
		packageManager = "yarn-berry"
	}

	const playwright = yield* firstOf(["playwright.config.ts", "playwright.config.js", "playwright.config.mjs"])
	const compose = yield* firstOf(["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"])
	const envExample = yield* firstOf([".env.example", ".env.sample", ".env.template"])

	return {
		compose: Option.match(compose, {
			onNone: () => ({}),
			onSome: (t) => Option.getOrElse(Option.liftThrowable(composeServices)(t), () => ({})),
		}),
		deps: Option.match(pkg, {
			onNone: () => [],
			onSome: (p) => [...Object.keys(p.dependencies ?? {}), ...Object.keys(p.devDependencies ?? {})],
		}),
		envExample: Option.match(envExample, { onNone: () => ({}), onSome: parseEnvFile }),
		packageManager,
		scripts: Option.match(pkg, { onNone: () => ({}), onSome: (p) => p.scripts ?? {} }),
		webServer: Option.match(playwright, { onNone: () => undefined, onSome: webServerIn }),
	} satisfies RepoFacts
})

/** The two places `witness publish` can put a report, as asked at init. */
export const EVIDENCE_CHOICES: ReadonlyArray<{
	readonly description: string
	readonly title: string
	readonly value: EvidenceDestination
}> = [
	{
		description:
			"Stills and the video are uploaded into the PR description (or a comment on someone else's PR). Needs an Ego browser signed in to GitHub.",
		title: "GitHub PR",
		value: "pr",
	},
	{
		description:
			"An unlisted report page (video with jump-to criteria, stills, logs); the PR gets a short summary that links to it. Needs WITNESS_REPORTS_URL and WITNESS_UPLOAD_TOKEN.",
		title: "Hosted page",
		value: "hosted",
	},
]

const EVIDENCE_QUESTION = "Where should Witness publish evidence (screenshots and video)?"

/** --evidence, else ask on a terminal; an agent or script must pass the flag. */
const evidenceFor = Effect.fn("evidenceFor")(function* (flag: Option.Option<EvidenceDestination>) {
	if (Option.isSome(flag)) {
		return flag.value
	}
	if (!(process.stdin.isTTY && process.stdout.isTTY)) {
		return yield* new InitError({
			message: `${EVIDENCE_QUESTION} Pass --evidence:\n${EVIDENCE_CHOICES.map((c) => `  --evidence ${c.value.padEnd(6)}  ${c.title}: ${c.description}`).join("\n")}`,
		})
	}
	return yield* Prompt.Select({
		choices: EVIDENCE_CHOICES,
		message: EVIDENCE_QUESTION,
	}).pipe(Effect.mapError(() => new InitError({ message: "init cancelled" })))
})

export const init = Effect.fn("init")(function* (o: {
	readonly repo: string
	readonly out: Option.Option<string>
	readonly force: boolean
	readonly evidence: Option.Option<EvidenceDestination>
}) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const repo = path.resolve(o.repo)
	if (!(yield* fs.exists(repo))) {
		return yield* new InitError({ message: `${repo} does not exist` })
	}
	const out = Option.match(o.out, { onNone: () => path.join(repo, "witness.yaml"), onSome: (p) => path.resolve(p) })
	if ((yield* fs.exists(out)) && !o.force) {
		return yield* new InitError({ message: `${out} already exists (use --force to overwrite)` })
	}

	const evidence = yield* evidenceFor(o.evidence)
	const drafted = draftConfig(yield* readFacts(repo))
	const draft: Draft = {
		config: { ...drafted.config, evidence, states: "before-after" },
		notes: [
			...drafted.notes,
			evidence === "pr"
				? "`evidence: pr`: `witness publish` uploads stills and the video into the PR. Change it to `hosted` for a hosted report page."
				: "`evidence: hosted`: `witness upload` makes a hosted report page and `witness publish` links it from the PR. Change it to `pr` to put the media in the PR itself.",
			"`states: before-after`: every run also checks the base commit first, so reviewers see the app before and after the change. Change it to `after` to record the change alone (one boot instead of two); `witness run --states` overrides it per run.",
		],
	}
	const text = renderDraft(draft)
	// The draft must at least be a valid witness.yaml.
	yield* parseWitnessConfig(text).pipe(
		Effect.mapError((e) => new InitError({ message: `draft is invalid, please report this: ${e.message}` }))
	)
	yield* fs.makeDirectory(path.dirname(out), { recursive: true })
	yield* fs.writeFileString(out, text)

	const rel = path.relative(process.cwd(), out)
	const shown = rel.startsWith("..") ? out : rel
	yield* Console.log(`wrote ${shown}\n`)
	for (const n of draft.notes) {
		yield* Console.log(`- ${n}`)
	}
	const ignore = yield* ignoreWitnessDir(repo)
	if (Option.isSome(ignore)) {
		const file = path.relative(process.cwd(), ignore.value)
		yield* Console.log(`- Added .witness/ (where runs are recorded) to ${file.startsWith("..") ? ignore.value : file}.`)
	}
	if (evidence === "hosted") {
		const reports = yield* Config.String("WITNESS_REPORTS_URL").pipe(Config.withDefault(""))
		const token = yield* Config.String("WITNESS_UPLOAD_TOKEN").pipe(Config.withDefault(""))
		if (!(reports && token)) {
			yield* Console.log(
				"- Hosted reports need WITNESS_REPORTS_URL and WITNESS_UPLOAD_TOKEN set; deploy the Worker first (README: Hosted reports on Cloudflare)."
			)
		}
	}
	yield* Console.log(`\nNext, prove it boots:\n  witness run --repo ${o.repo} --config ${shown} --boot-only`)
	return out
})
