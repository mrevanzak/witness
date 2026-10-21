// Infrastructure for hosted reports: an R2 bucket for manifests and media, and
// the Worker that serves it. `pnpm deploy` creates or updates both; `pnpm destroy`
// removes them.
//
// Config read at deploy time:
//   WITNESS_UPLOAD_TOKEN  bearer token the CLI uploads with (bound as a secret)
//   WITNESS_DOMAIN        optional custom domain, e.g. reports.example.com
import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import { Config, Effect, Option } from "effect"

// Prod resources are plain `witness`; other stages get a suffix (`witness-dev`).
// Bucket and Worker live in separate namespaces, so they share it.
const resourceName = Effect.gen(function* () {
	const stage = yield* Alchemy.Stage
	return stage === "prod" ? "witness" : `witness-${stage}`
})

export const Media = Cloudflare.R2.Bucket(
	"Media",
	Effect.map(resourceName, (name) => ({ name }))
)

export const Reports = Cloudflare.Worker(
	"Reports",
	Effect.gen(function* () {
		const domain = yield* Config.option(Config.String("WITNESS_DOMAIN")).pipe(Effect.orDie)
		return {
			compatibility: { date: "2026-09-25", flags: ["nodejs_compat"] },
			main: "./src/worker.ts",
			name: yield* resourceName,
			...Option.match(domain, { onNone: () => ({}), onSome: (name) => ({ domain: name }) }),
			env: {
				MEDIA: Media,
				// Report links use the Worker's canonical URL: the custom domain if set.
				PUBLIC_URL: Cloudflare.Worker.URL,
				UPLOAD_TOKEN: Config.Redacted("WITNESS_UPLOAD_TOKEN"),
			},
		}
	})
)

export type WorkerEnv = Cloudflare.InferEnv<typeof Reports>

export default Alchemy.Stack(
	"Witness",
	{ providers: Cloudflare.providers(), state: Cloudflare.state() },
	Effect.gen(function* () {
		const worker = yield* Reports
		return { url: worker.url }
	})
)
