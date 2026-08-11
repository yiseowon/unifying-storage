import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { authorized, cloneName, deletableProjectName, deletableSharedPath, issueFolderKey, safePath, sessionToken, validName, validSession } from "../hub-server.mjs";

test("public access requires the shared team login", () => {
  const header = `Basic ${Buffer.from("hackathon:correct horse").toString("base64")}`;
  assert.equal(authorized(header, "hackathon", "correct horse"), true);
  assert.equal(authorized(header, "hackathon", "wrong"), false);
  assert.equal(authorized(undefined, "hackathon", "correct horse"), false);
  const token = sessionToken("hackathon", "correct horse", 1_000_000);
  assert.equal(validSession(token, "hackathon", "correct horse", 1_000_000), true);
  assert.equal(validSession(token, "hackathon", "wrong", 1_000_000), false);
  assert.equal(validSession(token, "hackathon", "correct horse", 1_000_000 + 13 * 60 * 60 * 1000), false);
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
  assert.match(server, /\/api\/upload-archive/);
  assert.match(server, /validateArchiveTree/);
  assert.match(server, /\/api\/upload-chunks/);
  assert.match(server, /session\.archive \? "assembled\.zip" : "assembled"/);
  assert.match(server, /session\.json/);
  assert.match(server, /async function uploadSession/);
  assert.match(server, /path\.basename\(session\.name, path\.extname\(session\.name\)\)/);
  assert.match(page, /Math\.min\(4, session\.total\)/);
  assert.match(page, /\/s · 약/);
  assert.doesNotMatch(server, /MAX_UPLOAD|5GB 이하/);
});

test("file rows expose protected delete actions and custom login UI", async () => {
  const [page, server] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../hub-server.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(page, /deleteFile\(entry\)/);
  assert.match(server, /DELETE.*\/api\/files/);
  assert.match(server, /팀 워크스페이스에 접속하려면 로그인하세요/);
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
