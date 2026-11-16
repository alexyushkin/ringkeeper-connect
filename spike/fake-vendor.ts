// A pretend vendor with OAuth sign-in, for trying the app's sign-in flow
// without a real account. Same behaviour as test/oauth.test.ts.
//   node dist/fake-vendor.mjs [port]   → serves http://127.0.0.1:<port>/mcp
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { dirname, join, resolve } from "node:path";
import { Gateway } from "../packages/gateway/src/gateway.js";
import { spikeDefaultConfig } from "../packages/gateway/src/spike-config.js";
import { newToken } from "../packages/gateway/src/runtime.js";

const port = Number(process.argv[2] ?? 47811);
const base = `http://127.0.0.1:${port}`;
const innerToken = newToken();
const inner = new Gateway({
  config: spikeDefaultConfig(join(dirname(resolve(process.argv[1] ?? ".")), "fixture-server.mjs")),
  activeClientId: "acme",
  token: innerToken,
  port: 0,
});
await inner.start();

const clients = new Map<string, string[]>();
const codes = new Map<string, string>();
const access = new Set<string>();
const json = (res: http.ServerResponse, status: number, body: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
const body = async (req: http.IncomingMessage) => {
  let s = "";
  for await (const c of req) s += c;
  return s;
};

http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", base);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.pathname === "/register") {
      const meta = JSON.parse(await body(req));
      const id = `client_${clients.size + 1}`;
      clients.set(id, meta.redirect_uris);
      return json(res, 201, { ...meta, client_id: id });
    }
    if (url.pathname === "/authorize") {
      const redirect = url.searchParams.get("redirect_uri")!;
      const code = randomBytes(8).toString("hex");
      codes.set(code, url.searchParams.get("code_challenge")!);
      const back = new URL(redirect);
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      // A real vendor shows a consent page here; this one approves straight away.
      res.writeHead(302, { Location: back.toString() }).end();
      return;
    }
    if (url.pathname === "/token") {
      const form = new URLSearchParams(await body(req));
      const challenge = codes.get(form.get("code") ?? "");
      if (form.get("grant_type") === "authorization_code" && (!challenge || createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") !== challenge)) {
        return json(res, 400, { error: "invalid_grant" });
      }
      const at = `at_${randomBytes(6).toString("hex")}`;
      access.add(at);
      return json(res, 200, { access_token: at, refresh_token: `rt_${randomBytes(6).toString("hex")}`, token_type: "Bearer", expires_in: 3600 });
    }
    if (url.pathname === "/mcp") {
      if (!access.has((req.headers.authorization ?? "").replace(/^Bearer /, ""))) {
        res.writeHead(401, { "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` }).end();
        return;
      }
      const p = http.request(
        { host: "127.0.0.1", port: inner.port, path: "/mcp", method: req.method, headers: { ...req.headers, host: `127.0.0.1:${inner.port}`, authorization: `Bearer ${innerToken}` } },
        (pres) => {
          res.writeHead(pres.statusCode ?? 500, pres.headers);
          pres.pipe(res);
        },
      );
      req.pipe(p);
      return;
    }
    res.writeHead(404).end();
  })
  .listen(port, "127.0.0.1", () => console.log(`fake vendor at ${base}/mcp`));
