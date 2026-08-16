import { execFile } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync, realpathSync } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const USER_HOME = process.env.HUB_HOME || os.homedir();
const PROJECT_ROOT = process.env.HUB_PROJECT_ROOT || path.join(USER_HOME, "Developer");
const SHARED_ROOT = process.env.HUB_SHARED_ROOT || "/Volumes/UnifyingStorage";
const GIT = process.env.HUB_GIT || "/usr/bin/git";
const COLIMA = process.env.HUB_COLIMA || "/opt/homebrew/bin/colima";
const DOCKER = process.env.HUB_DOCKER || "/opt/homebrew/bin/docker";
const SCUTIL = process.env.HUB_SCUTIL || "/usr/sbin/scutil";
const NC = process.env.HUB_NC || "/usr/bin/nc";
const LSOF = process.env.HUB_LSOF || "/usr/sbin/lsof";
const DITTO = process.env.HUB_DITTO || "/usr/bin/ditto";
const MEMORY_PRESSURE = process.env.HUB_MEMORY_PRESSURE || "/usr/bin/memory_pressure";
const NPM = process.env.HUB_NPM || "npm";
const MAX_JSON = 1024 * 1024;
const MAX_TEXT_PREVIEW = 10 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".json", ".csv", ".log", ".js", ".jsx", ".ts", ".tsx", ".css", ".html", ".xml", ".yml", ".yaml", ".py", ".sh"]);
const SESSION_SECONDS = 12 * 60 * 60;
const UPLOAD_CHUNK = 32 * 1024 * 1024;
const UPLOAD_SESSIONS = path.join(os.tmpdir(), "mac-hub-upload-sessions");
const API_KEYS_FILE = process.env.HUB_API_KEYS_FILE || path.join(USER_HOME, ".unifying-storage", "api-keys.json");
const ADMIN_FILE = process.env.HUB_ADMIN_FILE || path.join(USER_HOME, ".unifying-storage", "admin.json");
const CLOUDFLARE_CONFIG = process.env.HUB_CLOUDFLARE_CONFIG || path.join(USER_HOME, ".cloudflared", "config.yml");
const uploadSessions = new Map();
let administrator;

async function keyStore(file = API_KEYS_FILE) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return { folders: [] };
    throw error;
  }
}

async function saveKeyStore(store, file = API_KEYS_FILE) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

const keyHash = (key) => createHash("sha256").update(key).digest("hex");

export async function issueFolderKey(relative, label = "API key", permission = "read", root = SHARED_ROOT, keysFile = API_KEYS_FILE) {
  const target = safePath(root, relative);
  if (!(await stat(target)).isDirectory()) throw new Error("API 키는 폴더에만 발급할 수 있습니다.");
  if (!['read', 'write'].includes(permission)) throw new Error("권한은 read 또는 write여야 합니다.");
  const store = await keyStore(keysFile);
  let folder = store.folders.find((item) => item.path === path.relative(root, target));
  if (!folder) {
    folder = { id: randomUUID(), path: path.relative(root, target), keys: [] };
    store.folders.push(folder);
  }
  const secret = `us_live_${randomBytes(32).toString("base64url")}`;
  const key = { id: randomUUID(), label: String(label || "API key").slice(0, 80), permission, hash: keyHash(secret), createdAt: new Date().toISOString() };
  folder.keys.push(key);
  await saveKeyStore(store, keysFile);
  return { folderId: folder.id, folderPath: folder.path, key: secret, keyId: key.id, label: key.label, permission };
}

async function folderAccess(request, folderId, write = false) {
  const secret = request.headers.authorization?.match(/^Bearer (us_live_[A-Za-z0-9_-]+)$/)?.[1];
  if (!secret) return null;
  const store = await keyStore();
  const folder = store.folders.find((item) => item.id === folderId);
  const hash = keyHash(secret);
  const key = folder?.keys.find((item) => sameText(item.hash, hash));
  if (!folder || !key || (write && key.permission !== "write")) return null;
  const root = safePath(SHARED_ROOT, folder.path);
  if (!(await stat(root)).isDirectory()) return null;
  return { folder, key, root };
}

async function uploadSession(id) {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) return null;
  if (uploadSessions.has(id)) return uploadSessions.get(id);
  try {
    const session = JSON.parse(await readFile(path.join(UPLOAD_SESSIONS, id, "session.json"), "utf8"));
    uploadSessions.set(id, session);
    return session;
  } catch { return null; }
}

const sameText = (left, right) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

export function passwordHash(password, salt = randomBytes(16).toString("hex")) {
  return { salt, hash: scryptSync(password, salt, 64).toString("hex") };
}

export function validPassword(password, credentials) {
  if (!password || !credentials?.salt || !credentials?.hash) return false;
  return sameText(scryptSync(password, credentials.salt, 64).toString("hex"), credentials.hash);
}

export function loadAdministrator(file = ADMIN_FILE) {
  const config = JSON.parse(readFileSync(file, "utf8"));
  if (config.username !== "Administrator" || !config.password?.salt || !config.password?.hash || !config.sessionSecret) {
    throw new Error(`관리자 설정이 올바르지 않습니다: ${file}`);
  }
  return config;
}

const signSession = (expires, secret) => createHmac("sha256", secret).update(String(expires)).digest("hex");

export function sessionToken(secret, now = Date.now()) {
  const expires = Math.floor(now / 1000) + SESSION_SECONDS;
  return `${expires}.${signSession(expires, secret)}`;
}

export function validSession(token, secret, now = Date.now()) {
  if (!token || !secret) return false;
  const [expiresText, signature] = token.split(".");
  const expires = Number(expiresText);
  return Number.isSafeInteger(expires) && expires > now / 1000 && sameText(signature || "", signSession(expires, secret));
}

function cookie(request, name) {
  return request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) || "";
}

function loggedIn(request) {
  return validSession(cookie(request, "hub_session"), administrator?.sessionSecret);
}

function loginPage(response, invalid = false) {
  response.writeHead(invalid ? 401 : 200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  response.end(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unifying Storage 로그인</title><style>
    :root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#17181a;background:#f1f4f8}*{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 50% 0,#e4f0ff 0,transparent 38%),#f4f6f9}.card{width:min(420px,100%);padding:38px;border:1px solid rgba(0,0,0,.08);border-radius:22px;background:rgba(255,255,255,.94);box-shadow:0 24px 70px rgba(28,45,72,.14);backdrop-filter:blur(18px)}.icon{width:52px;height:52px;display:grid;place-items:center;margin-bottom:24px;border-radius:15px;color:#fff;background:linear-gradient(145deg,#1684ff,#0065d8);box-shadow:0 10px 24px rgba(0,113,227,.28)}h1{margin:0;font-size:28px;letter-spacing:-.04em}p{margin:9px 0 28px;color:#68717d;font-size:14px;line-height:1.55}label{display:block;margin:15px 0 7px;color:#424851;font-size:13px;font-weight:650}input{width:100%;height:46px;padding:0 14px;border:1px solid #d8dde5;border-radius:11px;background:#fff;font-size:15px;outline:none}input:focus{border-color:#0071e3;box-shadow:0 0 0 4px rgba(0,113,227,.11)}button{width:100%;height:48px;margin-top:24px;border:0;border-radius:11px;color:#fff;background:#0071e3;font-size:15px;font-weight:700;cursor:pointer}button:hover{background:#0067d1}.error{margin:-8px 0 18px;padding:11px 13px;border-radius:9px;color:#a3211b;background:#ffebe9;font-size:13px}.foot{margin:19px 0 0;text-align:center;font-size:12px;color:#8b929c}@media(max-width:480px){.card{padding:30px 24px;border-radius:18px}}
  </style></head><body><main class="card"><div class="icon" aria-hidden="true"><svg width="27" height="27" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 16h.01M2.2 11.6A2 2 0 0 0 2 12.5V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.5a2 2 0 0 0-.2-.9L18.6 5.1A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.8 1.1zM22 12H2M6 16h.01"/></svg></div><h1>Unifying Storage</h1><p>관리자 워크스페이스에 접속하려면 로그인하세요.</p>${invalid ? '<div class="error" role="alert">비밀번호가 올바르지 않습니다.</div>' : ""}<form method="post" action="/login"><label for="user">아이디</label><input id="user" name="user" value="Administrator" autocomplete="username" readonly><label for="password">비밀번호</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus><button>로그인</button></form><p class="foot">Private storage · HTTPS secured</p></main></body></html>`);
}

async function login(request, response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) throw new Error("로그인 요청이 너무 큽니다.");
    chunks.push(chunk);
  }
  const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  if (!sameText(form.get("user") || "", administrator.username) || !validPassword(form.get("password") || "", administrator.password)) return loginPage(response, true);
  response.writeHead(303, {
    Location: "/",
    "Set-Cookie": `hub_session=${sessionToken(administrator.sessionSecret)}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`,
    "Cache-Control": "no-store",
  });
  response.end();
}

function requireLogin(request, response, url) {
  if (loggedIn(request)) return false;
  if (url.pathname.startsWith("/api/")) return Boolean(json(response, 401, { error: "로그인이 필요합니다." }) || true);
  response.writeHead(302, { Location: "/login", "Cache-Control": "no-store" });
  response.end();
  return true;
}

const exists = async (target) => access(target).then(() => true, () => false);

async function command(file, args = [], options = {}) {
  try {
    const { stdout, stderr } = await execute(file, args, {
      timeout: options.timeout ?? 15000,
      maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
      env: {
        ...process.env,
        HOME: USER_HOME,
        PATH: process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      },
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    const text = `${error.stderr || ""}\n${error.stdout || ""}`.trim();
    return { ok: false, stdout: "", stderr: text.slice(0, 400) || "명령 실행 실패" };
  }
}

export function safePath(root, relative = "") {
  if (typeof relative !== "string" || relative.includes("\0")) throw new Error("잘못된 경로입니다.");
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("허용된 공간 밖으로 이동할 수 없습니다.");
  }
  return resolved;
}

export function validName(name) {
  return typeof name === "string" && name.length > 0 && name.length <= 255 && !name.startsWith(".") && !/[\/\u0000-\u001f]/.test(name) && name !== "..";
}

export function cloneName(url) {
  if (typeof url !== "string") throw new Error("GitHub 주소가 필요합니다.");
  const match = url.match(/^(?:git@github\.com:|https:\/\/github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (!match) throw new Error("GitHub SSH 또는 HTTPS 저장소 주소만 허용됩니다.");
  return match[2];
}

export function deletableProjectName(name) {
  return validName(name) && name !== "mac-hub";
}

export function deletableSharedPath(relative) {
  if (typeof relative !== "string" || !relative) return false;
  let target;
  try { target = safePath(SHARED_ROOT, relative); } catch { return false; }
  const hub = safePath(SHARED_ROOT, "Developer/mac-hub");
  return target !== SHARED_ROOT && target !== hub && !hub.startsWith(`${target}${path.sep}`);
}

function rootFor(space) {
  if (space === "projects") return PROJECT_ROOT;
  if (space === "shared") return SHARED_ROOT;
  throw new Error("알 수 없는 파일 공간입니다.");
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_JSON) throw new Error("요청이 너무 큽니다.");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function json(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  });
  response.end(JSON.stringify(payload));
}

function checkOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  const protocol = request.headers["x-forwarded-proto"] || "http";
  const ownOrigin = `${protocol}://${request.headers.host}`;
  return origin === ownOrigin || origin === "http://localhost:3000" || origin === "http://127.0.0.1:3000";
}

async function disk(pathname) {
  if (!(await exists(pathname))) return null;
  const result = await command("/bin/df", ["-k", pathname]);
  if (!result.ok) return null;
  const line = result.stdout.split("\n").at(-1).trim().split(/\s+/);
  const total = Number(line[1]) * 1024;
  const used = Number(line[2]) * 1024;
  return { total, used, percent: Math.round((used / total) * 100), mount: line.slice(8).join(" ") || pathname };
}

async function projectInfo(entry) {
  const full = path.join(PROJECT_ROOT, entry.name);
  const info = await stat(full);
  const git = await exists(path.join(full, ".git"));
  let branch = "";
  let changes = 0;
  if (git) {
    const branchResult = await command(GIT, ["-C", full, "branch", "--show-current"]);
    const statusResult = await command(GIT, ["-C", full, "status", "--porcelain"]);
    branch = branchResult.ok ? branchResult.stdout : "";
    changes = statusResult.ok && statusResult.stdout ? statusResult.stdout.split("\n").length : 0;
  }
  return { name: entry.name, path: full, git, branch, changes, updatedAt: info.mtime.toISOString() };
}

async function projects() {
  const entries = await readdir(PROJECT_ROOT, { withFileTypes: true });
  const visible = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));
  const items = await Promise.all(visible.map(projectInfo));
  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function files(space, relative) {
  const root = rootFor(space);
  if (!(await exists(root))) throw new Error("공유 데이터 볼륨이 준비되지 않았습니다.");
  const target = safePath(root, relative);
  const entries = await readdir(target, { withFileTypes: true });
  const items = await Promise.all(entries.filter((entry) => !entry.name.startsWith(".")).map(async (entry) => {
    const full = path.join(target, entry.name);
    const info = await stat(full);
    const nextPath = path.relative(root, full);
    const directory = entry.isDirectory();
    let size = info.size;
    if (directory) {
      const result = await command("/usr/bin/du", ["-sk", full], { timeout: 30000 });
      size = result.ok ? Number(result.stdout.split(/\s+/)[0]) * 1024 : 0;
    }
    return { name: entry.name, path: nextPath, directory, size, updatedAt: info.mtime.toISOString() };
  }));
  return items.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, "ko"));
}

async function validateArchiveTree(target) {
  const info = await lstat(target);
  if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error("압축 파일에 허용되지 않은 항목이 있습니다.");
  if (info.isDirectory()) for (const entry of await readdir(target)) await validateArchiveTree(path.join(target, entry));
}

export function cloudflareRoutes(config = "") {
  const routes = [];
  let hostname = "";
  for (const line of config.split("\n")) {
    const host = line.match(/^\s*-?\s*hostname:\s*["']?([^"'#\s]+)["']?/);
    if (host) hostname = host[1];
    const service = line.match(/^\s*(?:-\s*)?service:\s*["']?([^"'#\s]+)["']?/);
    if (hostname && service) { routes.push({ hostname, service: service[1] }); hostname = ""; }
  }
  return routes;
}

export function dockerContainers(output = "") {
  return output.split("\n").filter(Boolean).flatMap((line) => {
    try {
      const item = JSON.parse(line);
      return [{ name: item.Names, image: item.Image, ports: item.Ports || "", status: item.Status }];
    } catch { return []; }
  });
}

export function tcpListeners(output = "") {
  const seen = new Set();
  return output.split("\n").slice(1).flatMap((line) => {
    const parts = line.trim().split(/\s+/);
    const address = parts.at(-1) === "(LISTEN)" ? parts.at(-2) : parts.at(-1);
    const port = address?.match(/:(\d+)$/)?.[1];
    const key = `${parts[0]}:${port}`;
    if (!port || seen.has(key)) return [];
    seen.add(key);
    return [{ process: parts[0], port: Number(port), address }];
  });
}

async function status() {
  const interfaces = os.networkInterfaces();
  const tailAddress = Object.values(interfaces).flat().find((item) => item?.family === "IPv4" && item.address.startsWith("100."))?.address || "";
  const [tailscale, ssh, colima, containers, listeners, tunnelConfig, memoryPressure, systemDisk, sharedDisk] = await Promise.all([
    command(SCUTIL, ["--nc", "list"]),
    command(NC, ["-z", "-w", "2", "127.0.0.1", "22"]),
    command(COLIMA, ["status"]),
    command(DOCKER, ["ps", "--format", "{{json .}}"]),
    command(LSOF, ["-nP", "-iTCP", "-sTCP:LISTEN"]),
    readFile(CLOUDFLARE_CONFIG, "utf8").catch(() => ""),
    command(MEMORY_PRESSURE, ["-Q"]),
    disk("/System/Volumes/Data"),
    disk(SHARED_ROOT),
  ]);
  const total = os.totalmem();
  const availablePercent = Number(memoryPressure.stdout.match(/free percentage:\s*(\d+)/i)?.[1] || 0);
  const percent = availablePercent ? 100 - availablePercent : Math.round(((total - os.freemem()) / total) * 100);
  const used = Math.round(total * percent / 100);
  return {
    hostname: os.hostname(),
    uptime: os.uptime(),
    memory: { total, used, percent },
    load: os.loadavg(),
    tailscale: { connected: tailscale.stdout.includes("(Connected)"), ip: tailAddress },
    ssh: ssh.ok,
    docker: { running: colima.ok && /colima is running/i.test(`${colima.stdout} ${colima.stderr}`), detail: colima.ok ? colima.stdout : "정지" },
    hosting: {
      routes: cloudflareRoutes(tunnelConfig),
      containers: containers.ok ? dockerContainers(containers.stdout) : [],
      listeners: listeners.ok ? tcpListeners(listeners.stdout) : [],
    },
    disks: { system: systemDisk, shared: sharedDisk },
    sharedReady: Boolean(sharedDisk),
    updatedAt: new Date().toISOString(),
  };
}

function streamFile(request, response, target, info, head = false) {
  const headers = {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(path.basename(target))}`,
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
  };
  const range = request.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= info.size) {
      response.writeHead(416, { "Content-Range": `bytes */${info.size}` });
      return response.end();
    }
    response.writeHead(206, { ...headers, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${info.size}` });
    return head ? response.end() : createReadStream(target, { start, end }).pipe(response);
  }
  response.writeHead(200, { ...headers, "Content-Length": info.size });
  return head ? response.end() : createReadStream(target).pipe(response);
}

async function publicFolderApi(request, response, url) {
  const match = url.pathname.match(/^\/api\/v1\/folders\/([0-9a-f-]{36})\/files(?:\/(.*))?$/);
  if (!match) return false;
  const relative = decodeURIComponent(match[2] || "");
  const write = request.method === "PUT" || request.method === "DELETE";
  const access = await folderAccess(request, match[1], write);
  if (!access) {
    json(response, write ? 403 : 401, { error: write ? "쓰기 권한이 없습니다." : "유효한 API 키가 필요합니다." });
    return true;
  }
  const target = safePath(access.root, relative);
  if ((request.method === "GET" || request.method === "HEAD") && await exists(target)) {
    const info = await stat(target);
    if (info.isFile()) return Boolean(streamFile(request, response, target, info, request.method === "HEAD") || true);
    if (!info.isDirectory()) throw new Error("지원하지 않는 파일 형식입니다.");
    const entries = await readdir(target, { withFileTypes: true });
    json(response, 200, { folderId: access.folder.id, path: relative, entries: await Promise.all(entries.filter((entry) => !entry.name.startsWith(".")).map(async (entry) => {
      const info = await stat(path.join(target, entry.name));
      return { name: entry.name, path: path.posix.join(relative, entry.name), directory: entry.isDirectory(), size: info.size, updatedAt: info.mtime.toISOString() };
    })) });
    return true;
  }
  if (request.method === "PUT") {
    if (!relative || !validName(path.basename(relative))) throw new Error("파일 경로가 필요합니다.");
    const length = Number(request.headers["content-length"] || 0);
    if (!Number.isSafeInteger(length) || length <= 0) throw new Error("올바른 Content-Length가 필요합니다.");
    await mkdir(path.dirname(target), { recursive: true });
    try { await pipeline(request, createWriteStream(target, { flags: "wx", mode: 0o640 })); }
    catch (error) { await rm(target, { force: true }); if (error.code === "EEXIST") throw new Error("같은 경로의 파일이 이미 있습니다."); throw error; }
    json(response, 201, { message: "업로드 완료", path: relative });
    return true;
  }
  if (request.method === "DELETE" && await exists(target) && target !== access.root) {
    await rm(target, { recursive: true });
    json(response, 200, { message: "삭제 완료" });
    return true;
  }
  json(response, 404, { error: "파일을 찾을 수 없습니다." });
  return true;
}

async function apiRequest(request, response, url) {
  if (!checkOrigin(request)) return json(response, 403, { error: "다른 웹사이트에서 보낸 요청은 거부됩니다." });
  if (request.method === "OPTIONS") return json(response, 204, {});

  if (request.method === "GET" && url.pathname === "/api/status") return json(response, 200, await status());
  if (request.method === "GET" && url.pathname === "/api/projects") return json(response, 200, { projects: await projects() });
  if (request.method === "GET" && url.pathname === "/api/folder-keys") {
    const relative = path.relative(SHARED_ROOT, safePath(SHARED_ROOT, url.searchParams.get("path") || ""));
    const folder = (await keyStore()).folders.find((item) => item.path === relative);
    return json(response, 200, { folderId: folder?.id || null, keys: (folder?.keys || []).map((key) => ({ id: key.id, label: key.label, permission: key.permission, createdAt: key.createdAt })) });
  }
  if (request.method === "POST" && url.pathname === "/api/folder-keys") {
    const body = await readJson(request);
    return json(response, 201, await issueFolderKey(body.path || "", body.label, body.permission));
  }
  if (request.method === "DELETE" && url.pathname === "/api/folder-keys") {
    const body = await readJson(request);
    const store = await keyStore();
    for (const folder of store.folders) folder.keys = folder.keys.filter((key) => key.id !== body.keyId);
    await saveKeyStore(store);
    return json(response, 200, { message: "API 키를 폐기했습니다." });
  }
  if (request.method === "GET" && url.pathname === "/api/files") {
    return json(response, 200, { entries: await files(url.searchParams.get("space") || "projects", url.searchParams.get("path") || "") });
  }
  if (request.method === "GET" && url.pathname === "/api/preview") {
    const root = rootFor(url.searchParams.get("space") || "shared");
    const target = safePath(root, url.searchParams.get("path") || "");
    const info = await stat(target);
    if (!info.isFile()) throw new Error("미리 볼 수 없는 항목입니다.");
    const extension = path.extname(target).toLowerCase();
    const audio = extension === ".mp3";
    if (!audio && !TEXT_EXTENSIONS.has(extension)) throw new Error("미리보기를 지원하지 않는 파일입니다.");
    if (!audio && info.size > MAX_TEXT_PREVIEW) throw new Error("10MB 이하의 텍스트 파일만 미리 볼 수 있습니다.");
    const headers = {
      "Content-Type": audio ? "audio/mpeg" : "text/plain; charset=utf-8",
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(path.basename(target))}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes",
    };
    const range = audio ? request.headers.range?.match(/^bytes=(\d*)-(\d*)$/) : null;
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= info.size) {
        response.writeHead(416, { "Content-Range": `bytes */${info.size}` });
        return response.end();
      }
      response.writeHead(206, { ...headers, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${info.size}` });
      return createReadStream(target, { start, end }).pipe(response);
    }
    response.writeHead(200, { ...headers, "Content-Length": info.size });
    return createReadStream(target).pipe(response);
  }
  if (request.method === "GET" && url.pathname === "/api/download") {
    const root = rootFor(url.searchParams.get("space") || "projects");
    const target = safePath(root, url.searchParams.get("path") || "");
    const info = await stat(target);
    if (info.isDirectory()) {
      const temporary = await mkdtemp(path.join(os.tmpdir(), "mac-hub-"));
      const archive = path.join(temporary, `${path.basename(target)}.zip`);
      const result = await command(DITTO, ["-c", "-k", "--sequesterRsrc", "--keepParent", target, archive], { timeout: 600000, maxBuffer: 1024 * 1024 });
      if (!result.ok) { await rm(temporary, { recursive: true, force: true }); throw new Error("폴더 압축에 실패했습니다."); }
      const archiveInfo = await stat(archive);
      response.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Length": archiveInfo.size,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${path.basename(target)}.zip`)}`,
        "X-Content-Type-Options": "nosniff",
      });
      response.on("finish", () => void rm(temporary, { recursive: true, force: true }));
      response.on("close", () => void rm(temporary, { recursive: true, force: true }));
      return createReadStream(archive).pipe(response);
    }
    if (!info.isFile()) throw new Error("다운로드할 수 없는 항목입니다.");
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": info.size,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(target))}`,
      "X-Content-Type-Options": "nosniff",
    });
    return createReadStream(target).pipe(response);
  }

  if (request.method === "POST" && url.pathname === "/api/projects") {
    const body = await readJson(request);
    if (!validName(body.name) || body.name.includes(" ")) throw new Error("프로젝트 이름은 문자, 숫자, 점, 밑줄, 하이픈만 사용할 수 있습니다.");
    const target = safePath(PROJECT_ROOT, body.name);
    if (await exists(target)) throw new Error("같은 이름의 폴더가 이미 있습니다.");
    await mkdir(target);
    const result = await command(GIT, ["-C", target, "init"]);
    if (!result.ok) { await rm(target, { recursive: true, force: true }); throw new Error("Git 초기화에 실패했습니다."); }
    return json(response, 201, { message: "프로젝트 생성 완료" });
  }

  if (request.method === "POST" && url.pathname === "/api/projects/import") {
    const body = await readJson(request);
    const source = safePath(SHARED_ROOT, body.path || "");
    const relative = path.relative(SHARED_ROOT, source);
    if (!relative || relative.split(path.sep)[0] === "Developer") throw new Error("이미 프로젝트 공간에 있는 폴더입니다.");
    const info = await stat(source);
    if (!info.isDirectory()) throw new Error("폴더만 프로젝트로 추가할 수 있습니다.");
    const name = path.basename(source);
    if (!validName(name)) throw new Error("프로젝트로 사용할 수 없는 폴더 이름입니다.");
    const destination = safePath(PROJECT_ROOT, name);
    if (await exists(destination)) throw new Error("같은 이름의 프로젝트가 이미 있습니다.");
    const result = await command(DITTO, [source, destination], { timeout: 600000, maxBuffer: 1024 * 1024 });
    if (!result.ok) {
      await rm(destination, { recursive: true, force: true });
      throw new Error("프로젝트 복사에 실패했습니다.");
    }
    return json(response, 201, { message: "프로젝트에 추가했습니다." });
  }

  if (request.method === "DELETE" && url.pathname === "/api/projects") {
    const body = await readJson(request);
    if (!deletableProjectName(body.name)) throw new Error(body.name === "mac-hub" ? "Unifying Storage 관리 프로젝트는 삭제할 수 없습니다." : "삭제할 수 없는 프로젝트 이름입니다.");
    const target = safePath(PROJECT_ROOT, body.name);
    const info = await stat(target);
    if (!info.isDirectory()) throw new Error("프로젝트 폴더가 아닙니다.");
    await rm(target, { recursive: true });
    return json(response, 200, { message: "프로젝트를 삭제했습니다." });
  }

  if (request.method === "POST" && url.pathname === "/api/clone") {
    const body = await readJson(request);
    const name = cloneName(body.url);
    const target = safePath(PROJECT_ROOT, name);
    if (await exists(target)) throw new Error("같은 이름의 프로젝트가 이미 있습니다.");
    const result = await command(GIT, ["clone", "--", body.url, target], { timeout: 120000, maxBuffer: 5 * 1024 * 1024 });
    if (!result.ok) { await rm(target, { recursive: true, force: true }); throw new Error(`Clone 실패: ${result.stderr}`); }
    return json(response, 201, { message: "저장소 복제 완료" });
  }

  if (request.method === "POST" && url.pathname === "/api/folders") {
    const body = await readJson(request);
    if (!validName(body.name)) throw new Error("사용할 수 없는 폴더 이름입니다.");
    const root = rootFor(body.space);
    if (!(await exists(root))) throw new Error("공유 데이터 볼륨이 준비되지 않았습니다.");
    const parent = safePath(root, body.path || "");
    await mkdir(safePath(parent, body.name), { recursive: true });
    return json(response, 201, { message: "폴더 생성 완료" });
  }

  if (request.method === "POST" && url.pathname === "/api/rename") {
    const body = await readJson(request);
    if (!validName(body.name)) throw new Error("사용할 수 없는 이름입니다.");
    const root = rootFor(body.space);
    const source = safePath(root, body.path || "");
    if (source === path.resolve(root)) throw new Error("최상위 폴더 이름은 변경할 수 없습니다.");
    const destination = safePath(root, path.join(path.dirname(path.relative(root, source)), body.name));
    if (await exists(destination)) throw new Error("같은 이름의 항목이 이미 있습니다.");
    await rename(source, destination);
    return json(response, 200, { message: "이름을 변경했습니다." });
  }

  if (request.method === "DELETE" && url.pathname === "/api/files") {
    const body = await readJson(request);
    if (body.space !== "shared" || !deletableSharedPath(body.path)) throw new Error("이 항목은 삭제할 수 없습니다.");
    const target = safePath(SHARED_ROOT, body.path);
    await rm(target, { recursive: true });
    return json(response, 200, { message: "항목을 삭제했습니다." });
  }

  if (request.method === "POST" && url.pathname === "/api/upload-sessions") {
    const body = await readJson(request);
    if (!Number.isSafeInteger(body.size) || body.size <= 0) throw new Error("올바른 파일 크기가 필요합니다.");
    if (!validName(body.name) || (body.archive && path.extname(body.name).toLowerCase() !== ".zip")) throw new Error("사용할 수 없는 파일 이름입니다.");
    const root = rootFor(body.space);
    const parent = safePath(root, body.path || "");
    const id = randomUUID();
    const temporary = path.join(UPLOAD_SESSIONS, id);
    await mkdir(temporary, { recursive: true });
    const session = { id, size: body.size, name: body.name, archive: Boolean(body.archive), parent, temporary, total: Math.ceil(body.size / UPLOAD_CHUNK) };
    uploadSessions.set(id, session);
    await writeFile(path.join(temporary, "session.json"), JSON.stringify(session), { mode: 0o600 });
    return json(response, 201, { id, chunkSize: UPLOAD_CHUNK, total: Math.ceil(body.size / UPLOAD_CHUNK) });
  }

  if (request.method === "PUT" && url.pathname === "/api/upload-chunks") {
    const session = await uploadSession(url.searchParams.get("id"));
    const index = Number(url.searchParams.get("index"));
    const length = Number(request.headers["content-length"] || 0);
    if (!session || !Number.isSafeInteger(index) || index < 0 || index >= session.total || !length || length > UPLOAD_CHUNK) throw new Error("잘못된 업로드 조각입니다.");
    const chunk = path.join(session.temporary, String(index).padStart(6, "0"));
    await pipeline(request, createWriteStream(chunk, { flags: "wx", mode: 0o640 }));
    return json(response, 201, { message: "조각 업로드 완료" });
  }

  if (request.method === "DELETE" && url.pathname === "/api/upload-sessions") {
    const session = await uploadSession(url.searchParams.get("id"));
    if (session) { uploadSessions.delete(session.id); await rm(session.temporary, { recursive: true, force: true }); }
    return json(response, 200, { message: "업로드 취소 완료" });
  }

  if (request.method === "POST" && url.pathname === "/api/upload-complete") {
    const body = await readJson(request);
    const session = await uploadSession(body.id);
    if (!session) throw new Error("업로드 세션이 만료됐습니다.");
    const assembled = path.join(session.temporary, session.archive ? "assembled.zip" : "assembled");
    try {
      let size = 0;
      for (let index = 0; index < session.total; index++) {
        const chunk = path.join(session.temporary, String(index).padStart(6, "0"));
        size += (await stat(chunk)).size;
        await pipeline(createReadStream(chunk), createWriteStream(assembled, { flags: index ? "a" : "wx", mode: 0o640 }));
      }
      if (size !== session.size) throw new Error("업로드 크기가 일치하지 않습니다.");
      if (!session.archive) {
        const destination = safePath(session.parent, session.name);
        if (await exists(destination)) throw new Error("같은 이름의 파일이 이미 있습니다.");
        await pipeline(createReadStream(assembled), createWriteStream(destination, { flags: "wx", mode: 0o640 }));
        return json(response, 201, { message: "업로드 완료" });
      }
      const extracted = path.join(session.temporary, "extracted");
      await mkdir(extracted);
      const result = await command(DITTO, ["-x", "-k", assembled, extracted], { timeout: 600000, maxBuffer: 1024 * 1024 });
      if (!result.ok) throw new Error("ZIP 압축을 풀지 못했습니다.");
      const entries = (await readdir(extracted)).filter((entry) => entry !== "__MACOSX" && !entry.startsWith("."));
      if (!entries.length) throw new Error("ZIP 파일이 비어 있습니다.");
      const only = entries.length === 1 ? path.join(extracted, entries[0]) : null;
      const singleFolder = only && (await lstat(only)).isDirectory();
      const source = singleFolder ? only : extracted;
      const folderName = singleFolder ? entries[0] : path.basename(session.name, path.extname(session.name));
      await validateArchiveTree(source);
      const destination = safePath(session.parent, folderName);
      if (await exists(destination)) throw new Error("같은 이름의 폴더가 이미 있습니다.");
      const copied = await command(DITTO, [source, destination], { timeout: 600000, maxBuffer: 1024 * 1024 });
      if (!copied.ok) { await rm(destination, { recursive: true, force: true }); throw new Error("압축을 푼 폴더를 저장하지 못했습니다."); }
      return json(response, 201, { message: `${folderName} 폴더 업로드 완료` });
    } finally {
      uploadSessions.delete(session.id);
      await rm(session.temporary, { recursive: true, force: true });
    }
  }

  if (request.method === "PUT" && url.pathname === "/api/upload") {
    const length = Number(request.headers["content-length"] || 0);
    if (!Number.isSafeInteger(length) || length <= 0) throw new Error("올바른 Content-Length가 필요합니다.");
    const name = url.searchParams.get("name") || "";
    if (!validName(name)) throw new Error("사용할 수 없는 파일 이름입니다.");
    const root = rootFor(url.searchParams.get("space") || "projects");
    if (!(await exists(root))) throw new Error("공유 데이터 볼륨이 준비되지 않았습니다.");
    const parent = safePath(root, url.searchParams.get("path") || "");
    const target = safePath(parent, name);
    try {
      await pipeline(request, createWriteStream(target, { flags: "wx", mode: 0o640 }));
    } catch (error) {
      await rm(target, { force: true });
      if (error.code === "EEXIST") throw new Error("같은 이름의 파일이 이미 있습니다.");
      throw error;
    }
    return json(response, 201, { message: "업로드 완료" });
  }

  if (request.method === "PUT" && url.pathname === "/api/upload-archive") {
    const length = Number(request.headers["content-length"] || 0);
    if (!Number.isSafeInteger(length) || length <= 0) throw new Error("올바른 Content-Length가 필요합니다.");
    const name = url.searchParams.get("name") || "";
    if (!validName(name) || path.extname(name).toLowerCase() !== ".zip") throw new Error("ZIP 파일만 업로드할 수 있습니다.");
    const root = rootFor(url.searchParams.get("space") || "shared");
    const parent = safePath(root, url.searchParams.get("path") || "");
    const temporary = await mkdtemp(path.join(os.tmpdir(), "mac-hub-upload-"));
    const archive = path.join(temporary, "upload.zip");
    const extracted = path.join(temporary, "extracted");
    try {
      await mkdir(extracted);
      await pipeline(request, createWriteStream(archive, { flags: "wx", mode: 0o640 }));
      const result = await command(DITTO, ["-x", "-k", archive, extracted], { timeout: 600000, maxBuffer: 1024 * 1024 });
      if (!result.ok) throw new Error("ZIP 압축을 풀지 못했습니다.");
      const entries = (await readdir(extracted)).filter((entry) => entry !== "__MACOSX" && !entry.startsWith("."));
      if (!entries.length) throw new Error("ZIP 파일이 비어 있습니다.");
      const only = entries.length === 1 ? path.join(extracted, entries[0]) : null;
      const singleFolder = only && (await lstat(only)).isDirectory();
      const source = singleFolder ? only : extracted;
      const folderName = singleFolder ? entries[0] : path.basename(name, path.extname(name));
      await validateArchiveTree(source);
      const destination = safePath(parent, folderName);
      if (await exists(destination)) throw new Error("같은 이름의 폴더가 이미 있습니다.");
      const copied = await command(DITTO, [source, destination], { timeout: 600000, maxBuffer: 1024 * 1024 });
      if (!copied.ok) { await rm(destination, { recursive: true, force: true }); throw new Error("압축을 푼 폴더를 저장하지 못했습니다."); }
      return json(response, 201, { message: `${folderName} 폴더 업로드 완료` });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  if (request.method === "POST" && url.pathname.startsWith("/api/actions/")) {
    const action = url.pathname.split("/").at(-1);
    const actions = {
      "docker-start": [COLIMA, ["start", "--cpu", "4", "--memory", "6", "--disk", "60"]],
      "docker-stop": [COLIMA, ["stop"]],
    };
    if (!actions[action]) throw new Error("허용되지 않은 작업입니다.");
    const [file, args] = actions[action];
    const result = await command(file, args, { timeout: action === "docker-start" ? 180000 : 30000, maxBuffer: 4 * 1024 * 1024 });
    if (!result.ok) throw new Error(result.stderr || "작업 실행 실패");
    const messages = { "docker-start": "Docker가 준비됐습니다.", "docker-stop": "Docker를 중지했습니다." };
    return json(response, 200, { message: messages[action] });
  }

  return json(response, 404, { error: "찾을 수 없는 기능입니다." });
}

function proxy(request, response) {
  const upstream = http.request({ hostname: "127.0.0.1", port: 3000, path: request.url, method: request.method, headers: request.headers }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", () => json(response, 503, { error: "화면 서버를 시작하는 중입니다. 잠시 후 새로고침하세요." }));
  request.pipe(upstream);
}

function tailscaleAddress() {
  if (process.env.HUB_HOST) return process.env.HUB_HOST;
  return Object.values(os.networkInterfaces()).flat().find((item) => item?.family === "IPv4" && item.address.startsWith("100."))?.address;
}

export function startHub() {
  administrator = loadAdministrator();
  const host = tailscaleAddress();
  if (!host) throw new Error("Tailscale IPv4 주소가 없어 Mac Hub를 안전하게 시작할 수 없습니다.");
  const port = Number(process.env.HUB_PORT || 8787);
  let frontend;
  if (process.env.HUB_NO_FRONTEND !== "1") {
    frontend = execFile(NPM, ["run", "start", "--", "--hostname", "127.0.0.1", "--port", "3000"], {
      cwd: APP_DIR,
      env: { ...process.env, HOME: USER_HOME, HOST: "127.0.0.1", PORT: "3000" },
    });
  }
  const server = http.createServer(async (request, response) => {
    let requestPath = "";
    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || `${host}:${port}`}`);
      requestPath = url.pathname;
      if (url.pathname === "/login" && request.method === "GET") return loginPage(response);
      if (url.pathname === "/login" && request.method === "POST") return await login(request, response);
      if (url.pathname.startsWith("/api/v1/folders/")) {
        if (await publicFolderApi(request, response, url)) return;
      }
      if (requireLogin(request, response, url)) return;
      if (url.pathname.startsWith("/api/")) return await apiRequest(request, response, url);
      return proxy(request, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : "요청 처리 실패";
      console.error(`${new Date().toISOString()} ${request.method} ${requestPath}: ${message}`);
      return json(response, 400, { error: message });
    }
  });
  server.listen(port, host, () => console.log(`Mac Hub: http://${host}:${port}`));
  const stop = () => { server.close(); frontend?.kill(); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return server;
}

async function setupAdministrator() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const password = Buffer.concat(chunks).toString("utf8").trimEnd();
  if (password.length < 8) throw new Error("비밀번호는 8자 이상이어야 합니다.");
  const config = { username: "Administrator", password: passwordHash(password), sessionSecret: randomBytes(32).toString("hex") };
  await mkdir(path.dirname(ADMIN_FILE), { recursive: true, mode: 0o700 });
  await writeFile(ADMIN_FILE, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  console.log(`Administrator 설정 완료: ${ADMIN_FILE}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--setup-admin") await setupAdministrator();
  else startHub();
}
