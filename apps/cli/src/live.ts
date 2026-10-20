// `witness run --live`: a local page that streams the computer's desktop (noVNC,
// view only) next to the criteria checklist and the step log as they happen.
// Run events arrive over Server-Sent Events; late joiners get the history first.

import { createServer } from "node:http"
import { NodeHttpServer } from "@effect/platform-node"
import type { LiveEvent } from "@witness/orchestrator"
import { Effect, Layer, PubSub, Ref, Stream } from "effect"
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http"
import { LIVE_PAGE } from "./live-page.ts"

/** Serves `routes` on host loopback, on a port the OS picks, for the current scope. Returns its origin. */
export const serveLoopback = <E, R>(routes: Layer.Layer<never, E, R>) =>
	Layer.build(
		HttpRouter.serve(routes, { disableLogger: true }).pipe(
			Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))
		)
	).pipe(Effect.flatMap((context) => HttpServer.addressFormattedWith(Effect.succeed).pipe(Effect.provide(context))))

const encoder = new TextEncoder()
const sse = (data: unknown) => encoder.encode(`data: ${JSON.stringify(data)}\n\n`)

/** Starts the live server for the current scope; returns its URL and the publisher to hand to the run. */
export const startLive = Effect.fn("startLive")(function* () {
	const events = yield* PubSub.unbounded<LiveEvent>()
	const history = yield* Ref.make<readonly LiveEvent[]>([])
	const publish = (event: LiveEvent) =>
		Ref.update(history, (h) => [...h, event]).pipe(Effect.andThen(PubSub.publish(events, event)), Effect.asVoid)

	const origin = yield* serveLoopback(
		Layer.mergeAll(
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
	)
	return { publish, url: `${origin}/` }
})
