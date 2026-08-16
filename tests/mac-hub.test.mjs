import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cloneName, cloudflareRoutes, deletableProjectName, deletableSharedPath, dockerContainers, issueFolderKey, passwordHash, safePath, sessionToken, tcpListeners, validName, validPassword, validSession } from "../hub-server.mjs";

test("Administrator password is hashed and sessions use a separate secret", () => {
  const credentials = passwordHash("correct horse", "fixed-test-salt");
  assert.equal(validPassword("correct horse", credentials), true);
  assert.equal(validPassword("wrong", credentials), false);
  assert.doesNotMatch(credentials.hash, /correct horse/);
  const token = sessionToken("session-secret", 1_000_000);
  assert.equal(validSession(token, "session-secret", 1_000_000), true);
  assert.equal(validSession(token, "wrong-secret", 1_000_000), false);
  assert.equal(validSession(token, "session-secret", 1_000_000 + 13 * 60 * 60 * 1000), false);
});

test("hosting status parses Cloudflare routes, Docker containers, and TCP listeners", () => {
  assert.deepEqual(cloudflareRoutes("ingress:\n  - hostname: storage.example.com\n    service: http://127.0.0.1:8787\n  - service: http_status:404\n"), [
    { hostname: "storage.example.com", service: "http://127.0.0.1:8787" },
  ]);
  assert.deepEqual(dockerContainers('{"Names":"web","Image":"example/web:latest","Ports":"0.0.0.0:8080->80/tcp","Status":"Up 2 hours"}'), [
    { name: "web", image: "example/web:latest", ports: "0.0.0.0:8080->80/tcp", status: "Up 2 hours" },
  ]);
  assert.deepEqual(tcpListeners("COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 42 user 20u IPv4 0x0 0t0 TCP 127.0.0.1:8787 (LISTEN)"), [
    { process: "node", port: 8787, address: "127.0.0.1:8787" },
  ]);
});

test("filesystem actions stay inside their allowed root", () => {
  assert.equal(safePath("/srv/projects", "demo"), "/srv/projects/demo");
  assert.throws(() => safePath("/srv/projects", "../../etc"), /허용된 공간 밖/);
});

test("project and file names reject traversal", () => {
  assert.equal(validName("vision-lab"), true);
  assert.equal(validName("내 자료"), true);
  assert.equal(validName("../secret"), false);
  assert.equal(validName("a/b"), false);
});

test("clone accepts only plain GitHub repository URLs", () => {
  assert.equal(cloneName("git@github.com:openai/example.git"), "example");
  assert.equal(cloneName("https://github.com/openai/example"), "example");
  assert.throws(() => cloneName("https://token@github.com/openai/example.git"), /GitHub/);
  assert.throws(() => cloneName("https://example.com/repo.git"), /GitHub/);
});

test("project deletion protects the running hub and rejects traversal", () => {
  assert.equal(deletableProjectName("demo-project"), true);
  assert.equal(deletableProjectName("mac-hub"), false);
  assert.equal(deletableProjectName("../outside"), false);
});

test("shared deletion protects the storage root and running hub", () => {
  assert.equal(deletableSharedPath("team/demo.txt"), true);
  assert.equal(deletableSharedPath("Developer/other-project"), true);
  assert.equal(deletableSharedPath("Developer/mac-hub"), false);
  assert.equal(deletableSharedPath("Developer"), false);
  assert.equal(deletableSharedPath(""), false);
});

test("production build contains the Unifying Storage shell", async () => {
  const bundle = await readFile(new URL("../dist/server/index.js", import.meta.url), "utf8");
  assert.match(bundle, /Unifying Storage/);
  assert.match(bundle, /Storage/);
  assert.doesNotMatch(bundle, /Mac mini 내장 SSD/);
  assert.doesNotMatch(bundle, /Codex 문구 복사/);
  assert.doesNotMatch(bundle, /codex-preview|react-loading-skeleton/);
});

test("shared folders can be copied into projects", async () => {
  const [page, server] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../hub-server.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(page, /프로젝트로 추가/);
  assert.match(page, /호스팅 현황/);
  assert.match(server, /\/api\/projects\/import/);
  assert.match(page, /preview-dialog/);
  assert.match(server, /\/api\/preview/);
});

test("ZIP folder uploads are extracted server-side and can be cancelled", async () => {
  const [page, server] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../hub-server.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(page, /ZIP 폴더 선택/);
  assert.match(page, /activeUploads\.current/);
  assert.match(page, /activeUploadSessions\.current/);
  assert.match(server, /\/api\/upload-archive/);
  assert.match(server, /validateArchiveTree/);
  assert.match(server, /\/api\/upload-chunks/);
  assert.match(server, /session\.archive \? "assembled\.zip" : "assembled"/);
  assert.match(server, /session\.json/);
  assert.match(server, /async function uploadSession/);
  assert.match(server, /path\.basename\(session\.name, path\.extname\(session\.name\)\)/);
  assert.match(page, /CHUNKS_PER_FILE = 3/);
  assert.match(page, /FILE_UPLOAD_CONCURRENCY = 10/);
  assert.match(page, /Math\.min\(FILE_UPLOAD_CONCURRENCY, selected\.length\)/);
  assert.match(page, /upload-item/);
  assert.match(server, /const UPLOAD_CHUNK = 32 \* 1024 \* 1024/);
  assert.match(page, /\/s · 약/);
  assert.doesNotMatch(server, /MAX_UPLOAD|5GB 이하/);
});

test("file rows expose protected delete actions and Administrator login UI", async () => {
  const [page, server] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../hub-server.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(page, /deleteFile\(entry\)/);
  assert.match(server, /DELETE.*\/api\/files/);
  assert.match(server, /value="Administrator"/);
  assert.match(server, /scryptSync/);
  assert.doesNotMatch(server, /HUB_PASSWORD/);
  assert.match(server, /HttpOnly; Secure; SameSite=Strict/);
});

test("folder API keys are unique and stored only as hashes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "unifying-storage-test-"));
  const keysFile = path.join(root, "config", "keys.json");
  try {
    await mkdir(path.join(root, "dataset"));
    const first = await issueFolderKey("dataset", "reader", "read", root, keysFile);
    const second = await issueFolderKey("dataset", "writer", "write", root, keysFile);
    assert.match(first.key, /^us_live_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(first.key, second.key);
    assert.equal(first.folderId, second.folderId);
    const stored = await readFile(keysFile, "utf8");
    assert.doesNotMatch(stored, new RegExp(first.key));
    assert.match(stored, /"permission": "write"/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
