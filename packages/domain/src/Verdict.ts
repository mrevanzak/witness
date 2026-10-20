import type { CriterionStatus } from "./Ids.ts"

/**
 * Overall verdict from per-criterion statuses (decided by code, not the model):
 *   fail    - any criterion failed
 *   blocked - nothing failed but something could not be checked (or there were no criteria)
 *   pass    - every criterion passed
 * An unverified criterion never yields pass.
 */
export function aggregateOverall(criteria: ReadonlyArray<{ readonly status: CriterionStatus }>): CriterionStatus {
	if (criteria.length === 0) return "blocked"
	if (criteria.some((c) => c.status === "fail")) return "fail"
	if (criteria.some((c) => c.status === "blocked")) return "blocked"
	return "pass"
}

export const EXIT_CODES: Record<CriterionStatus, number> = { pass: 0, fail: 1, blocked: 2 }
