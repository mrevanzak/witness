import { Schema } from "effect"

/** A run: `YYYYMMDD-HHMMSS-<hex>` locally; uploads get an unguessable public id. */
export const RunId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{5,80}$/)),
  Schema.brand("@witness/RunId")
)
export type RunId = typeof RunId.Type

/** Public id of an uploaded report: 22 base62 chars (~131 bits), the unlisted-link secret. */
export const ReportId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9A-Za-z]{22}$/)),
  Schema.brand("@witness/ReportId")
)
export type ReportId = typeof ReportId.Type

/** `C1`, `C2`, ... */
export const CriterionId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^C[1-9][0-9]?$/)),
  Schema.brand("@witness/CriterionId")
)
export type CriterionId = typeof CriterionId.Type

export const CriterionStatus = Schema.Literals(["pass", "fail", "blocked"])
export type CriterionStatus = typeof CriterionStatus.Type

export const CriterionKind = Schema.Literals(["feature", "regression"])
export type CriterionKind = typeof CriterionKind.Type
