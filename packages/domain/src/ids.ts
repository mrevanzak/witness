import { Schema } from "effect"

/** Public id of an uploaded report: 22 base62 chars (~131 bits), the unlisted-link secret. */
export const ReportId = Schema.String.pipe(
	Schema.check(Schema.isPattern(/^[0-9A-Za-z]{22}$/)),
	Schema.brand("@witness/ReportId")
)
export type ReportId = typeof ReportId.Type

export const CriterionStatus = Schema.Literals(["pass", "fail", "blocked"])
export type CriterionStatus = typeof CriterionStatus.Type

export const CriterionKind = Schema.Literals(["feature", "regression"])
export type CriterionKind = typeof CriterionKind.Type
