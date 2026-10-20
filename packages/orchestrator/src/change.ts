import type { Option } from "effect"
import type { RepoRef } from "./git.ts"

/** What is being verified: the task, the code change, and repo context for the planner. */
export type Change = {
	/** The witness.yaml text the run used (secrets are redacted before the model sees it). */
	readonly configText: string
	/** Extra context for the planner (e.g. PR title/body). */
	readonly context: Option.Option<string>
	readonly diff: string
	readonly files: ReadonlyArray<{ readonly status: string; readonly path: string }>
	readonly readme: Option.Option<string>
	readonly repo: RepoRef
	readonly task: string
}
