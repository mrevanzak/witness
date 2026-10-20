// `witness run --live`: a local page that streams the computer's desktop (noVNC,
// view only) next to the criteria checklist and the step log as they happen.
// Run events arrive over Server-Sent Events; late joiners get the history first.

import { createServer } from "node:http"
import { createServer as createNetServer } from "node:net"
import { NodeHttpServer } from "@effect/platform-node"
import type { LiveEvent } from "@witness/orchestrator"
import { Effect, Layer, PubSub, Ref, Stream } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { LIVE_PAGE } from "./live-page.ts"

export const freePort = Effect.callback<number>((resume) => {
	const srv = createNetServer()
	srv.listen(0, "127.0.0.1", () => {
		const address = srv.address()
		const port = typeof address === "object" && address ? address.port : 0
		srv.close(() => resume(Effect.succeed(port)))
	})
})

const encoder = new TextEncoder()
const sse = (data: unknown) => encoder.encode(`data: ${JSON.stringify(data)}\n\n`)

/** Starts the live server for the current scope; returns its URL and the publisher to hand to the run. */
export const startLive = Effect.fn("startLive")(function* () {
	const events = yield* PubSub.unbounded<LiveEvent>()
	const history = yield* Ref.make<readonly LiveEvent[]>([])
	const publish = (event: LiveEvent) =>
		Ref.update(history, (h) => [...h, event]).pipe(Effect.andThen(PubSub.publish(events, event)), Effect.asVoid)

	const routes = Layer.mergeAll(
		HttpRouter.add("GET", "/", HttpServerResponse.html(LIVE_PAGE)),
		HttpRouter.add(
			"GET",
			"/events",
			Effect.gen(function* () {
				const past = yield* Ref.get(history)
				const body = Stream.concat(Stream.fromIterable(past), Stream.fromPubSub(events)).pipe(
					Stream.map(sse),
					// A comment line every 15 s keeps proxies and the browser from closing the stream.
					Stream.merge(Stream.tick("15 seconds").pipe(Stream.map(() => encoder.encode(": keep-alive\n\n"))))
				)
				return HttpServerResponse.stream(body, {
					contentType: "text/event-stream",
					headers: { "cache-control": "no-cache", connection: "keep-alive" },
				})
			})
		)
	)

	const port = yield* freePort
	yield* Layer.launch(
		HttpRouter.serve(routes, { disableLogger: true }).pipe(
			Layer.provide(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port }))
		)
	).pipe(Effect.forkScoped)
	return { publish, url: `http://127.0.0.1:${port}/` }
})
