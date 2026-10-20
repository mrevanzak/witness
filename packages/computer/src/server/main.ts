// Entrypoint of the control server inside the computer image (bundled to
// infra/computer/control/dist/control.mjs). SIGTERM from start.sh interrupts the
// program: the recorder finalises a running recording, Chromium and spawned
// commands are stopped, then the process exits.

import { createServer } from "node:http"
import { NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node"
import { Layer } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { CONTROL_PORT, ControlApi } from "../protocol.ts"
import { Artifacts } from "./artifacts.ts"
import { Browser, ChromeLive } from "./browser.ts"
import { Display } from "./display.ts"
import { Exec } from "./exec.ts"
import { Recorder } from "./recorder.ts"
import { ControlAuthLive, ControlHandlers, StatusHandlers } from "./routes.ts"

const ServicesLive = Layer.mergeAll(Display.layer, Browser.layer, Exec.layer, Recorder.layer, ChromeLive).pipe(
	Layer.provideMerge(Artifacts.layer),
	Layer.provideMerge(NodeServices.layer)
)

const ApiLive = HttpApiBuilder.layer(ControlApi).pipe(
	Layer.provide([StatusHandlers, ControlHandlers]),
	Layer.provide(ControlAuthLive)
)

const ServerLive = HttpRouter.serve(ApiLive).pipe(
	Layer.provide(NodeHttpServer.layer(createServer, { host: "0.0.0.0", port: CONTROL_PORT }))
)

Layer.launch(ServerLive.pipe(Layer.provide(ServicesLive))).pipe(NodeRuntime.runMain)
