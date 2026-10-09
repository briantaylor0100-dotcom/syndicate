import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Server as SocketServer } from "socket.io";
import { GameEngine, createInitialWorld } from "./engine.js";
import { MemoryStore } from "./store.js";
import { AccountService, AUTH_COOKIE, AUTH_COOKIE_MAX_AGE } from "./accounts.js";
import { ChatService } from "./chat.js";

const store = new MemoryStore(createInitialWorld());
const engine = new GameEngine(store);
const accounts = new AccountService();
const port = Number(process.env.PORT ?? 3000);
const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const authThrottle = new Map();

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function servePage(pathname, response) {
  const files = {
    "/": ["login.html", "text/html; charset=utf-8"],
    "/login": ["login.html", "text/html; charset=utf-8"],
    "/login.css": ["login.css", "text/css; charset=utf-8"],
    "/login.js": ["login.js", "text/javascript; charset=utf-8"],
    "/play": ["index.html", "text/html; charset=utf-8"],
    "/styles.css": ["styles.css", "text/css; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  };
  const file = files[pathname];
  if (!file) return false;
  try {
    const content = await readFile(join(publicDir, file[0]));
    response.writeHead(200, { "content-type": file[1], "cache-control": "no-store" });
    response.end(content);
  } catch {
    send(response, 500, { error: "Game client could not be loaded" });
  }
  return true;
}

function cookieToken(request) {
  const entry = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${AUTH_COOKIE}=`));
  return entry ? decodeURIComponent(entry.slice(AUTH_COOKIE.length + 1)) : "";
}

function authenticatedUser(request) {
  return accounts.authenticate(cookieToken(request));
}

function setSession(response, token, clear = false) {
  const flags = [
    `${AUTH_COOKIE}=${clear ? "" : encodeURIComponent(token)}`,
    "Path=/", "HttpOnly", "SameSite=Strict",
    `Max-Age=${clear ? 0 : AUTH_COOKIE_MAX_AGE}`,
  ];
  if (process.env.NODE_ENV === "production") flags.push("Secure");
  response.setHeader("set-cookie", flags.join("; "));
}

function throttled(request) {
  const address = request.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  const record = authThrottle.get(address) ?? { startedAt: now, attempts: 0 };
  if (now - record.startedAt > 15 * 60_000) {
    record.startedAt = now;
    record.attempts = 0;
  }
  record.attempts += 1;
  authThrottle.set(address, record);
  return record.attempts > 30;
}

async function readJson(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 16_384) throw new Error("Request body too large");
  }
  return raw ? JSON.parse(raw) : {};
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
  if (request.method === "GET" && url.pathname === "/play" && !authenticatedUser(request)) {
    response.writeHead(302, { location: "/" });
    return response.end();
  }
  if (request.method === "GET" && await servePage(url.pathname, response)) return;

  try {
    if (request.method === "POST" && url.pathname === "/api/register") {
      if (throttled(request)) return send(response, 429, { error: "Too many authentication requests. Try again later." });
      const result = await accounts.register(await readJson(request));
      engine.createPlayer(result.user);
      setSession(response, result.token);
      return send(response, 201, { user: result.user });
    }
    if (request.method === "POST" && url.pathname === "/api/login") {
      if (throttled(request)) return send(response, 429, { error: "Too many authentication requests. Try again later." });
      const result = await accounts.login(await readJson(request));
      engine.createPlayer(result.user);
      setSession(response, result.token);
      return send(response, 200, { user: result.user });
    }
    if (request.method === "POST" && url.pathname === "/api/logout") {
      const user = authenticatedUser(request);
      if (user) {
        accounts.revoke(user.id);
        io.in(`user:${user.id}`).disconnectSockets(true);
      }
      setSession(response, "", true);
      return send(response, 200, { ok: true });
    }
    if (request.method === "GET" && url.pathname === "/api/me") {
      const user = authenticatedUser(request);
      return user ? send(response, 200, { user }) : send(response, 401, { error: "Authentication required" });
    }

    const user = authenticatedUser(request);
    if (!user) return send(response, 401, { error: "Authentication required" });
    if (request.method === "GET" && url.pathname === "/api/state") return send(response, 200, engine.getState(user.id));
    if (request.method === "GET" && url.pathname === "/api/players") return send(response, 200, engine.listPlayers());
    if (request.method === "POST" && url.pathname === "/api/actions") {
      const input = await readJson(request);
      const result = engine.performAction({ ...input, playerId: user.id });
      return send(response, result.error ? result.status : 200, result);
    }
    if (request.method === "POST" && url.pathname === "/api/companies") {
      const input = await readJson(request);
      const result = engine.foundCompany(user.id, input.name);
      return send(response, result.error ? result.status : 201, result);
    }
    if (request.method === "POST" && url.pathname === "/api/companies/actions") {
      const result = engine.companyAction(user.id, await readJson(request));
      return send(response, result.error ? result.status : 200, result);
    }
    return send(response, 404, { error: "Route not found" });
  } catch (error) {
    const message = error.message === "Request body too large" ? error.message : error.message || "Request failed";
    const status = error.message.startsWith("Invalid username/email") ? 401 : error.message === "Too many authentication requests. Try again later." ? 429 : 400;
    return send(response, status, { error: message });
  }
});

const io = new SocketServer(server);
const chat = new ChatService(io, store, accounts);
const npcTimer = setInterval(() => {
  const events = engine.advanceNpcBehavior();
  for (const event of events) chat.broadcastNpcAlert(event);
}, 30_000);
npcTimer.unref();
const economyTimer = setInterval(() => engine.getState(""), 60_000);
economyTimer.unref();

server.listen(port, () => console.log(`Syndicate server listening on http://localhost:${port}`));
