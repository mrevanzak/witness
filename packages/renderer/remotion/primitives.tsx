// Small pieces drawn over the video: status chips, the cursor and click ripples.

import type { CriterionStatus } from "@witness/domain"
import { interpolate } from "remotion"
import { PACING } from "../src/timeline"
import { C, MONO, STATUS } from "./theme"

export function Chip({ status, children }: { status: CriterionStatus; children: React.ReactNode }) {
	const color = STATUS[status]
	return (
		<span
			style={{
				border: `1px solid ${color}66`,
				borderRadius: 4,
				color,
				fontFamily: MONO,
				fontSize: 14,
				fontWeight: 500,
				letterSpacing: 1,
				padding: "2px 7px",
				textTransform: "uppercase",
			}}
		>
			{children}
		</span>
	)
}

export function Cursor({ x, y, scale, opacity }: { x: number; y: number; scale: number; opacity: number }) {
	const s = 1.3 / Math.sqrt(scale)
	return (
		<svg
			height={32}
			style={{
				filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.5))",
				left: x,
				opacity,
				position: "absolute",
				top: y,
				transform: `translate(-6px,-4px) scale(${s})`,
				transformOrigin: "6px 4px",
			}}
			viewBox="0 0 32 32"
			width={32}
		>
			<path
				d="M6 4 L6 26 L12 20 L16 29 L20 27 L16 18 L24 18 Z"
				fill="#fff"
				stroke={C.ink}
				strokeLinejoin="round"
				strokeWidth={1.6}
			/>
		</svg>
	)
}

export function Ring({ x, y, age }: { x: number; y: number; age: number }) {
	const r = interpolate(age, [0, PACING.cursor.glide], [4, 34], { extrapolateRight: "clamp" })
	const o = interpolate(age, [0, PACING.cursor.glide], [0.9, 0], { extrapolateRight: "clamp" })
	return (
		<div
			style={{
				border: "2.5px solid #fff",
				borderRadius: "50%",
				boxShadow: `0 0 0 1px ${C.ink}55`,
				height: 2 * r,
				left: x - r,
				opacity: o,
				position: "absolute",
				top: y - r,
				width: 2 * r,
			}}
		/>
	)
}
