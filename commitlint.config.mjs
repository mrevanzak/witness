export default {
	extends: ["@commitlint/config-conventional"],
	rules: {
		"type-enum": [
			2,
			"always",
			["feat", "fix", "docs", "chore", "style", "refactor", "ci", "build", "test", "perf", "revert"],
		],
	},
}
