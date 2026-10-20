import type { Option } from "effect"
import type { RepoRef } from "./Git.ts"

/** What is being verified: the task, the code change, and repo context for the planner. */
export interface Change {
	readonly repo: RepoRef
	readonly task: string
	readonly diff: string
	readonly files: ReadonlyArray<{ readonly status: string; readonly path: string }>
	readonly readme: Option.Option<string>
	/** The witness.yaml text the run used (secrets are redacted before the model sees it). */
	readonly configText: string
	/** Extra context for the planner (e.g. PR title/body). */
	readonly context: Option.Option<string>
}
