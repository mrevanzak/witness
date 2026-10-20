// Infrastructure for hosted reports: an R2 bucket for media, a D1 database
// for report rows, and the Worker that serves both. `pnpm deploy` creates or
// updates all of it; `pnpm destroy` removes it.
//
// Config read at deploy time:
//   WITNESS_UPLOAD_TOKEN  bearer token the CLI uploads with (bound as a secret)
//   WITNESS_DOMAIN        optional custom domain, e.g. reports.example.com
import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import { Config, Effect, Option } from "effect"

export const Media = Cloudflare.R2.Bucket("Media")

export const Db = Cloudflare.D1.Database("Db", { migrations: "./migrations" })

export const Reports = Cloudflare.Worker(
	"Reports",
	Effect.gen(function* () {
		const domain = yield* Config.option(Config.String("WITNESS_DOMAIN")).pipe(Effect.orDie)
		return {
			main: "./src/worker.ts",
			compatibility: { flags: ["nodejs_compat"], date: "2026-09-25" },
			...Option.match(domain, { onNone: () => ({}), onSome: (name) => ({ domain: name }) }),
			env: {
				MEDIA: Media,
				DB: Db,
				UPLOAD_TOKEN: Config.Redacted("WITNESS_UPLOAD_TOKEN"),
				// Report links use the Worker's canonical URL: the custom domain if set.
				PUBLIC_URL: Cloudflare.Worker.URL,
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
