import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import worker from "./dist/server/index.js";

const clientRoot = resolve(
  fileURLToPath(new URL("./dist/client/", import.meta.url)),
);
const host = process.env.HOST || "0.0.0.0";
const parsedPort = Number.parseInt(process.env.PORT || "8080", 10);
const port =
  Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535
    ? parsedPort
    : 8080;

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function requestUrl(request) {
  const forwardedProto = request.headers["x-forwarded-proto"];
  const protocol =
    typeof forwardedProto === "string"
      ? forwardedProto.split(",")[0].trim()
      : request.socket.encrypted
        ? "https"
        : "http";
  const forwardedHost = request.headers["x-forwarded-host"];
  const hostname =
    (typeof forwardedHost === "string"
      ? forwardedHost.split(",")[0].trim()
      : request.headers.host) || `${host}:${port}`;
  return new URL(request.url || "/", `${protocol}://${hostname}`);
}

function localAssetPath(pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const relativePath = decodedPath.replace(/^\/+/, "");
  if (!relativePath) return null;
  const candidate = resolve(clientRoot, relativePath);
  if (!candidate.startsWith(`${clientRoot}${sep}`)) return null;
  return candidate;
}

async function assetResponse(request) {
  const url = new URL(request.url);
  const assetPath = localAssetPath(url.pathname);
  if (!assetPath) return new Response("Not found", { status: 404 });

  let file;
  try {
    file = await stat(assetPath);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  if (!file.isFile()) return new Response("Not found", { status: 404 });

  const headers = new Headers({
    "Content-Length": String(file.size),
    "Content-Type":
      mimeTypes.get(extname(assetPath).toLowerCase()) ||
      "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
  });

  if (url.pathname.startsWith("/assets/")) {
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
  } else {
    headers.set("Cache-Control", "public, max-age=3600");
  }

  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  return new Response(Readable.toWeb(createReadStream(assetPath)), {
    status: 200,
    headers,
  });
}

function webRequest(nodeRequest, url) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(nodeRequest.headers)) {
    if (Array.isArray(value)) {
      value.forEach((item) => headers.append(name, item));
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }

  const init = {
    method: nodeRequest.method || "GET",
    headers,
  };
  if (init.method !== "GET" && init.method !== "HEAD") {
    init.body = Readable.toWeb(nodeRequest);
    init.duplex = "half";
  }
  return new Request(url, init);
}

async function sendResponse(nodeResponse, response) {
  nodeResponse.statusCode = response.status;
  response.headers.forEach((value, name) => {
    nodeResponse.setHeader(name, value);
  });
  nodeResponse.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  nodeResponse.setHeader("X-Content-Type-Options", "nosniff");

  if (!response.body) {
    nodeResponse.end();
    return;
  }

  await new Promise((resolvePromise, rejectPromise) => {
    const body = Readable.fromWeb(response.body);
    body.on("error", rejectPromise);
    nodeResponse.on("error", rejectPromise);
    nodeResponse.on("finish", resolvePromise);
    body.pipe(nodeResponse);
  });
}

const server = createServer(async (nodeRequest, nodeResponse) => {
  try {
    const url = requestUrl(nodeRequest);
    const request = webRequest(nodeRequest, url);

    const asset = await assetResponse(request);
    if (asset.status !== 404) {
      await sendResponse(nodeResponse, asset);
      return;
    }

    const pending = [];
    const context = {
      passThroughOnException() {},
      waitUntil(promise) {
        pending.push(Promise.resolve(promise));
      },
    };
    const environment = {
      ASSETS: { fetch: assetResponse },
      IMAGES: {
        input() {
          throw new Error(
            "Image optimization is unavailable in the portable server. TERRAWATCH does not require it.",
          );
        },
      },
    };

    const response = await worker.fetch(request, environment, context);
    await sendResponse(nodeResponse, response);
    void Promise.allSettled(pending);
  } catch (error) {
    console.error(error);
    if (!nodeResponse.headersSent) {
      nodeResponse.statusCode = 500;
      nodeResponse.setHeader("Content-Type", "text/plain; charset=utf-8");
    }
    nodeResponse.end("TERRAWATCH server error");
  }
});

server.listen(port, host, () => {
  console.log(`TERRAWATCH is running at http://${host}:${port}`);
});

function shutdown(signal) {
  console.log(`${signal} received; shutting down.`);
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
