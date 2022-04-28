import { PassThrough } from "stream";
import type * as express from "express";
import type {
  AppLoadContext,
  ServerBuild,
  RequestInit as NodeRequestInit,
  Response as NodeResponse,
} from "@remix-run/node";
import { ReadableStream } from "@remix-run/web-stream";
import {
  // This has been added as a global in node 15+
  AbortController,
  createRequestHandler as createRemixRequestHandler,
  Headers as NodeHeaders,
  Request as NodeRequest,
} from "@remix-run/node";

/**
 * A function that returns the value to use as `context` in route `loader` and
 * `action` functions.
 *
 * You can think of this as an escape hatch that allows you to pass
 * environment/platform-specific values through to your loader/action, such as
 * values that are generated by Express middleware like `req.session`.
 */
export type GetLoadContextFunction = (
  req: express.Request,
  res: express.Response
) => AppLoadContext;

export type RequestHandler = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => Promise<void>;

/**
 * Returns a request handler for Express that serves the response using Remix.
 */
export function createRequestHandler({
  build,
  getLoadContext,
  mode = process.env.NODE_ENV,
}: {
  build: ServerBuild;
  getLoadContext?: GetLoadContextFunction;
  mode?: string;
}): RequestHandler {
  let handleRequest = createRemixRequestHandler(build, mode);

  return async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    try {
      let abortController = new AbortController();
      let request = createRemixRequest(req, abortController);
      let loadContext =
        typeof getLoadContext === "function"
          ? getLoadContext(req, res)
          : undefined;

      let response = await handleRequest(
        request as unknown as Request,
        loadContext
      );

      sendRemixResponse(res, response, abortController);
    } catch (error) {
      // Express doesn't support async functions, so we have to pass along the
      // error manually using next().
      next(error);
    }
  };
}

export function createRemixHeaders(
  requestHeaders: express.Request["headers"]
): Headers {
  let headers = new NodeHeaders();

  for (let [key, values] of Object.entries(requestHeaders)) {
    if (values) {
      if (Array.isArray(values)) {
        for (let value of values) {
          headers.append(key, value);
        }
      } else {
        headers.set(key, values);
      }
    }
  }

  return headers;
}

export function createRemixRequest(
  req: express.Request,
  abortController?: AbortController
): NodeRequest {
  let origin = `${req.protocol}://${req.get("host")}`;
  let url = new URL(req.url, origin);

  let init: NodeRequestInit = {
    method: req.method,
    headers: createRemixHeaders(req.headers),
    signal: abortController?.signal,
    abortController,
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = new ReadableStream({
      start(controller) {
        req.on("data", (chunk) => {
          controller.enqueue(chunk);
        });
        req.on("end", () => {
          controller.close();
        });
      },
    });
  }

  return new NodeRequest(url.href, init);
}

export function sendRemixResponse(
  res: express.Response,
  nodeResponse: Response,
  abortController: AbortController
): void {
  res.statusMessage = nodeResponse.statusText;
  res.status(nodeResponse.status);

  for (let [key, value] of Object.entries(nodeResponse.headers)) {
    res.append(key, value);
  }

  if (abortController.signal.aborted) {
    res.set("Connection", "close");
  }

  if (nodeResponse.body) {
    let reader = nodeResponse.body.getReader();
    async function read() {
      let { done, value } = await reader.read();
      if (done) {
        res.end(value);
        return;
      }

      res.write(value);
      read();
    }
    read();
  } else {
    res.end();
  }
  // if (Buffer.isBuffer(nodeResponse.body)) {
  //   res.end(nodeResponse.body);
  // } else if (nodeResponse.body?.pipe) {
  //   nodeResponse.body.pipe(res);
  // } else {
  //   res.end();
  // }
}
