// Static server for the e2e tests: /fixtures/* serves the test pages, everything
// else serves the built extension (dist) so the side panel can run in a normal tab.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const fixtures = join(root, "tests/e2e/fixtures");
const dist = resolve(process.env.E2E_DIST ?? join(root, "dist"));
const port = Number(process.env.PORT ?? 4173);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };

createServer(async (request, response) => {
  const path = normalize(decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname));
  const file = path.startsWith("/fixtures/") ? join(fixtures, path.slice("/fixtures/".length)) : join(dist, path);
  if (!file.startsWith(fixtures) && !file.startsWith(dist)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" }).end(body);
  } catch {
    response.writeHead(404).end("not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`e2e server on http://127.0.0.1:${port}`));
