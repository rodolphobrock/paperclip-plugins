// Stand-in for ntfy (POST / with a JSON publish) and apprise-api (POST /notify[/key]) that records
// every request. Control endpoints:
//   GET  /__requests         recorded requests as JSON
//   POST /__status?code=503  reply with this status until changed (200 restores)
import http from "node:http";

const port = Number(process.env.MOCK_PORT ?? 18080);
const requests = [];
let status = 200;

http
  .createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://mock");
      if (url.pathname === "/__requests") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(requests));
        return;
      }
      if (url.pathname === "/__status") {
        status = Number(url.searchParams.get("code") ?? 200);
        res.end(JSON.stringify({ status }));
        return;
      }
      let body = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        // keep the raw text
      }
      requests.push({
        at: new Date().toISOString(),
        method: req.method,
        path: url.pathname,
        headers: req.headers,
        body,
        replied: status,
      });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(status === 200 ? { ok: true } : { error: "mock unavailable" }));
    });
  })
  .listen(port, "127.0.0.1", () => console.log(`mock listening on 127.0.0.1:${port}`));
