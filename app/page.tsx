"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, File, FileText, Folder, FolderUp, HardDrive, Music2, Pencil, Search, Trash2, X } from "lucide-react";

type Disk = { used: number; total: number; percent: number; mount: string };
type HubStatus = {
  hostname: string;
  uptime: number;
  memory: { used: number; total: number; percent: number };
  tailscale: { connected: boolean; ip: string };
  ssh: boolean;
  docker: { running: boolean; detail: string };
  disks: { system: Disk; shared: Disk | null };
  sharedReady: boolean;
  updatedAt: string;
};

type Project = { name: string; path: string; git: boolean; branch: string; changes: number; updatedAt: string };
type FileEntry = { name: string; path: string; directory: boolean; size: number; updatedAt: string };
type UploadProgress = {
  title: string;
  detail: string;
  percent: number;
  sent: number;
  total: number;
  done: boolean;
  speed?: number;
  eta?: number;
  error?: string;
};
type Preview = { entry: FileEntry; kind: "audio" | "text"; content: string; loading: boolean; error?: string };

const textExtensions = /\.(txt|md|json|csv|log|js|jsx|ts|tsx|css|html|xml|yml|yaml|py|sh)$/i;
const previewKind = (name: string) => name.toLowerCase().endsWith(".mp3") ? "audio" : textExtensions.test(name) ? "text" : null;

const apiBase = () => typeof window !== "undefined" && window.location.port === "3000" ? "http://127.0.0.1:8787" : "";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`, {
    ...init,
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "요청을 처리하지 못했습니다.");
  return payload;
}

const storage = (value = 0) => {
  if (!value) return "0 GB";
  if (value >= 1024 ** 4) return `${(value / 1024 ** 4).toFixed(2)} TB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
};

const fileSize = (value = 0) => {
  if (!value) return "0 KB";
  if (value < 1_000_000) return `${Math.max(1, Math.round(value / 1_000))} KB`;
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
  if (value < 1_000_000_000_000) return `${(value / 1_000_000_000).toFixed(1)} GB`;
  return `${(value / 1_000_000_000_000).toFixed(2)} TB`;
};

const relativeTime = (iso: string) => {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}시간 전`;
  return `${Math.floor(minutes / 1440)}일 전`;
};

export default function Home() {
  const [status, setStatus] = useState<HubStatus | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const space = "shared" as const;
  const [path, setPath] = useState("");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("연결 중");
  const [projectName, setProjectName] = useState("");
  const [cloneUrl, setCloneUrl] = useState("");
  const [search, setSearch] = useState("");
  const [uploadMenu, setUploadMenu] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [renameEntry, setRenameEntry] = useState<FileEntry | null>(null);
  const [renameName, setRenameName] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const activeUploads = useRef(new Set<XMLHttpRequest>());
  const activeUploadSession = useRef("");
  const uploadCancelled = useRef(false);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api<HubStatus>("/api/status"));
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "연결 실패");
    }
  }, []);

  const loadProjects = useCallback(async () => {
    const data = await api<{ projects: Project[] }>("/api/projects");
    setProjects(data.projects);
  }, []);

  const loadFiles = useCallback(async (nextSpace = space, nextPath = path) => {
    const params = new URLSearchParams({ space: nextSpace, path: nextPath });
    const data = await api<{ entries: FileEntry[] }>(`/api/files?${params}`);
    setFiles(data.entries);
  }, [path, space]);

  const refreshAll = useCallback(async () => {
    setNotice("갱신 중");
    try {
      await Promise.all([loadStatus(), loadProjects(), loadFiles()]);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "갱신 실패");
    }
  }, [loadFiles, loadProjects, loadStatus]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshAll(), 0);
    return () => window.clearTimeout(timer);
  }, [refreshAll]);

  useEffect(() => {
    const timer = window.setInterval(loadStatus, 5000);
    return () => window.clearInterval(timer);
  }, [loadStatus]);

  useEffect(() => {
    if (!preview) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setPreview(null); };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", close);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", close);
    };
  }, [preview]);

  const run = async (action: string, label: string) => {
    setBusy(action);
    setNotice(`${label} 처리 중`);
    try {
      const result = await api<{ message: string }>(`/api/actions/${action}`, { method: "POST", body: "{}" });
      setNotice(result.message);
      await loadStatus();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : `${label} 실패`);
    } finally {
      setBusy("");
    }
  };

  const createProject = async (event: FormEvent) => {
    event.preventDefault();
    if (!projectName.trim()) return;
    setBusy("create");
    try {
      await api("/api/projects", { method: "POST", body: JSON.stringify({ name: projectName.trim() }) });
      setProjectName("");
      setNotice("프로젝트를 만들었습니다.");
      await Promise.all([loadProjects(), loadFiles()]);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "프로젝트 생성 실패");
    } finally {
      setBusy("");
    }
  };

  const cloneProject = async (event: FormEvent) => {
    event.preventDefault();
    if (!cloneUrl.trim()) return;
    setBusy("clone");
    setNotice("저장소 복제 중");
    try {
      await api("/api/clone", { method: "POST", body: JSON.stringify({ url: cloneUrl.trim() }) });
      setCloneUrl("");
      setNotice("저장소를 복제했습니다.");
      await Promise.all([loadProjects(), loadFiles()]);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "저장소 복제 실패");
    } finally {
      setBusy("");
    }
  };

  const goTo = async (nextPath: string) => {
    setPath(nextPath);
    await loadFiles(space, nextPath);
  };

  const createFolder = async () => {
    const name = window.prompt("새 폴더 이름을 입력하세요.")?.trim();
    if (!name) return;
    setBusy("folder");
    try {
      await api("/api/folders", { method: "POST", body: JSON.stringify({ space, path, name }) });
      setNotice("폴더를 만들었습니다.");
      await loadFiles();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "폴더 생성 실패");
    } finally {
      setBusy("");
    }
  };

  const uploadOne = async (file: File, targetPath: string, onProgress: (loaded: number, speed: number) => void, archive = false) => {
    const session = await api<{ id: string; chunkSize: number; total: number }>("/api/upload-sessions", { method: "POST", body: JSON.stringify({ space, path: targetPath, name: file.name, size: file.size, archive }) });
    activeUploadSession.current = session.id;
    const loaded = Array(session.total).fill(0) as number[];
    const started = performance.now();
    let next = 0;
    const worker = async () => {
      while (next < session.total) {
        const index = next++;
        if (uploadCancelled.current) throw new Error("업로드를 취소했습니다.");
        const chunk = file.slice(index * session.chunkSize, Math.min(file.size, (index + 1) * session.chunkSize));
        await new Promise<void>((resolve, reject) => {
          const request = new XMLHttpRequest();
          activeUploads.current.add(request);
          request.open("PUT", `${apiBase()}/api/upload-chunks?${new URLSearchParams({ id: session.id, index: String(index) })}`);
          request.setRequestHeader("Content-Type", "application/octet-stream");
          request.upload.onprogress = (event) => {
            loaded[index] = event.loaded;
            const sent = loaded.reduce((sum, value) => sum + value, 0);
            onProgress(sent, sent / Math.max(0.25, (performance.now() - started) / 1000));
          };
          request.onload = () => {
            activeUploads.current.delete(request);
            if (request.status < 300) resolve();
            else reject(new Error("업로드 조각 전송에 실패했습니다."));
          };
          request.onerror = () => { activeUploads.current.delete(request); reject(new Error("업로드 연결이 끊겼습니다.")); };
          request.onabort = () => { activeUploads.current.delete(request); reject(new Error("업로드를 취소했습니다.")); };
          request.send(chunk);
        });
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(4, session.total) }, worker));
      await api("/api/upload-complete", { method: "POST", body: JSON.stringify({ id: session.id }) });
    } catch (error) {
      await api(`/api/upload-sessions?id=${session.id}`, { method: "DELETE" }).catch(() => {});
      throw error;
    } finally {
      activeUploadSession.current = "";
    }
  };

  const cancelUpload = () => {
    uploadCancelled.current = true;
    for (const request of activeUploads.current) request.abort();
    if (activeUploadSession.current) void api(`/api/upload-sessions?id=${activeUploadSession.current}`, { method: "DELETE" }).catch(() => {});
  };

  const updateUpload = (patch: Partial<UploadProgress>) => {
    setUploadProgress((current) => current ? { ...current, ...patch } : current);
  };

  const uploadFiles = async (list: FileList) => {
    setUploadMenu(false);
    const selected = Array.from(list);
    if (!selected.length) return;
    const total = selected.reduce((sum, file) => sum + file.size, 0);
    let completed = 0;
    uploadCancelled.current = false;
    setUploadProgress({ title: "파일 업로드", detail: "업로드 준비 중", percent: 0, sent: 0, total, done: false });
    setBusy("upload");
    try {
      for (let index = 0; index < selected.length; index++) {
        if (uploadCancelled.current) throw new Error("업로드를 취소했습니다.");
        const file = selected[index];
        await uploadOne(file, path, (loaded, speed) => {
          const sent = completed + loaded;
          updateUpload({ detail: `${index + 1}/${selected.length} · ${file.name}`, sent, speed, eta: speed ? (total - sent) / speed : undefined, percent: total ? Math.round(sent / total * 100) : 100 });
        });
        completed += file.size;
      }
      setNotice(`${selected.length}개 파일 업로드 완료`);
      updateUpload({ detail: `${selected.length}개 파일 업로드 완료`, sent: total, percent: 100, done: true });
      await loadFiles();
    } catch (error) {
      const message = error instanceof Error ? error.message : "업로드 실패";
      setNotice(message);
      updateUpload({ detail: "업로드 실패", done: true, error: message });
    } finally {
      setBusy("");
    }
  };

  const uploadArchive = async (list: FileList) => {
    setUploadMenu(false);
    const file = list[0];
    if (!file) return;
    uploadCancelled.current = false;
    setUploadProgress({ title: "ZIP 폴더 업로드", detail: file.name, percent: 0, sent: 0, total: file.size, done: false });
    setBusy("archive-upload");
    try {
      await uploadOne(file, path, (sent, speed) => updateUpload({ detail: file.name, sent, speed, eta: speed ? (file.size - sent) / speed : undefined, percent: file.size ? Math.round(sent / file.size * 100) : 100 }), true);
      setNotice("ZIP 폴더 업로드 완료");
      updateUpload({ detail: "NAS에서 압축 해제 완료", sent: file.size, percent: 100, done: true });
      await loadFiles();
    } catch (error) {
      const message = error instanceof Error ? error.message : "ZIP 폴더 업로드 실패";
      setNotice(message);
      updateUpload({ detail: message, done: true, error: message });
    } finally {
      setBusy("");
    }
  };

  const renameFile = async (event: FormEvent) => {
    event.preventDefault();
    if (!renameEntry || !renameName.trim()) return;
    setBusy("rename");
    try {
      await api("/api/rename", { method: "POST", body: JSON.stringify({ space, path: renameEntry.path, name: renameName.trim() }) });
      setRenameEntry(null);
      setRenameName("");
      setNotice("이름을 변경했습니다.");
      await loadFiles();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "이름 변경 실패");
    } finally {
      setBusy("");
    }
  };

  const breadcrumbs = useMemo(() => {
    const pieces = path ? path.split("/") : [];
    return [{ name: "공유 저장소", path: "" }].concat(
      pieces.map((name, index) => ({ name, path: pieces.slice(0, index + 1).join("/") })),
    );
  }, [path]);

  const deleteProject = async (project: Project) => {
    if (project.name === "mac-hub") {
      setNotice("Unifying Storage 관리 프로젝트는 삭제할 수 없습니다.");
      return;
    }
    if (!window.confirm(`“${project.name}” 프로젝트와 내부 파일을 정말 영구 삭제할까요?\n이 작업은 되돌릴 수 없습니다.`)) return;
    setBusy(`delete:${project.name}`);
    try {
      await api("/api/projects", { method: "DELETE", body: JSON.stringify({ name: project.name }) });
      await loadProjects();
      setNotice(`${project.name} 프로젝트를 삭제했습니다.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "프로젝트 삭제 실패");
    } finally {
      setBusy("");
    }
  };

  const beginRename = (entry: FileEntry) => {
    setRenameEntry(entry);
    setRenameName(entry.name);
  };

  const deleteFile = async (entry: FileEntry) => {
    if (entry.path === "Developer" || entry.path === "Developer/mac-hub") {
      setNotice("Unifying Storage 관리 폴더는 삭제할 수 없습니다.");
      return;
    }
    if (!window.confirm(`“${entry.name}”${entry.directory ? " 폴더와 내부 파일을" : " 파일을"} 영구 삭제할까요?\n이 작업은 되돌릴 수 없습니다.`)) return;
    setBusy(`file-delete:${entry.path}`);
    try {
      await api("/api/files", { method: "DELETE", body: JSON.stringify({ space, path: entry.path }) });
      setNotice(`${entry.name}을 삭제했습니다.`);
      await Promise.all([loadFiles(), loadProjects()]);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "삭제 실패");
    } finally {
      setBusy("");
    }
  };

  const addProject = async (entry: FileEntry) => {
    if (entry.path === "Developer" || entry.path.startsWith("Developer/")) {
      setNotice(`${entry.name}은 이미 프로젝트 공간에 있습니다.`);
      return;
    }
    setBusy(`project:${entry.path}`);
    setNotice(`${entry.name} 프로젝트 복사 중`);
    try {
      await api("/api/projects/import", { method: "POST", body: JSON.stringify({ path: entry.path }) });
      await loadProjects();
      setNotice(`${entry.name}을 프로젝트에 추가했습니다.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "프로젝트 추가 실패");
    } finally {
      setBusy("");
    }
  };

  const downloadUrl = (entry: FileEntry) => `${apiBase()}/api/download?${new URLSearchParams({ space, path: entry.path })}`;
  const previewUrl = (entry: FileEntry) => `${apiBase()}/api/preview?${new URLSearchParams({ space, path: entry.path })}`;
  const openPreview = async (entry: FileEntry) => {
    const kind = previewKind(entry.name);
    if (!kind) {
      setNotice("이 파일은 다운로드해서 열어주세요.");
      return;
    }
    setPreview({ entry, kind, content: "", loading: kind === "text" });
    if (kind === "audio") return;
    try {
      const response = await fetch(previewUrl(entry), { cache: "no-store" });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "텍스트를 불러오지 못했습니다.");
      }
      const content = await response.text();
      setPreview((current) => current?.entry.path === entry.path ? { ...current, content, loading: false } : current);
    } catch (error) {
      const message = error instanceof Error ? error.message : "텍스트를 불러오지 못했습니다.";
      setPreview((current) => current?.entry.path === entry.path ? { ...current, loading: false, error: message } : current);
    }
  };
  const visibleFiles = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("ko");
    return query ? files.filter((entry) => entry.name.toLocaleLowerCase("ko").includes(query)) : files;
  }, [files, search]);

  const storageDisk = status?.disks.shared;
  const storagePercent = storageDisk ? (storageDisk.used / storageDisk.total) * 100 : 0;
  const updated = status ? new Date(status.updatedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";

  return (
    <main className="app-shell">
      <header className="page-heading">
        <div><h1>Unifying Storage</h1></div>
        <div className="heading-actions">
          {notice && <span className="notice">{notice}</span>}
          <span className={`status-dot ${status?.tailscale.connected ? "ok" : "bad"}`} />
          <span>{status?.tailscale.connected ? "연결됨" : "연결 끊김"}</span>
          <button className="refresh-button" onClick={refreshAll} aria-label="전체 정보 새로고침">새로고침</button>
        </div>
      </header>

      <section className="storage-grid" aria-label="저장공간">
        <article className="storage-card backup-card">
          <div className="card-title"><div><span className="drive-icon"><HardDrive size={20} strokeWidth={1.8} /></span><div><h3>Storage</h3></div></div><span className="capacity">{storageDisk ? `${storagePercent.toFixed(1)}% 사용` : "연결 안 됨"}</span></div>
          {storageDisk && <>
            <div className="storage-summary"><strong>{storage(storageDisk.total - storageDisk.used)}</strong><span>사용 가능</span></div>
            <div className="storage-bar" aria-label={`사용 중 ${storage(storageDisk.used)}, 사용 가능 ${storage(storageDisk.total - storageDisk.used)}`}><i className="backup-segment" style={{ width: `${storagePercent}%` }} /><i className="free-segment" /></div>
            <div className="storage-legend"><div><i className="backup-color" /><span>사용 중</span><strong>{storage(storageDisk.used)}</strong></div><div><i className="free-color" /><span>사용 가능</span><strong>{storage(storageDisk.total - storageDisk.used)}</strong></div></div>
            <div className="storage-total">실제 포맷 용량 {storage(storageDisk.total)}</div>
          </>}
        </article>

        <article className="service-card">
          <div className="service-title"><div><h3>상태</h3><p>마지막 확인 {updated}</p></div></div>
          <ServiceRow name="Tailscale" value={status?.tailscale.ip || "확인 중"} active={Boolean(status?.tailscale.connected)} />
          <ServiceRow name="SSH" value={status?.ssh ? "키 인증" : "확인 필요"} active={Boolean(status?.ssh)} />
          <ServiceRow name="Docker" value={status?.docker.running ? "실행 중" : "정지"} active={Boolean(status?.docker.running)} action={<button onClick={() => run(status?.docker.running ? "docker-stop" : "docker-start", "Docker")} disabled={busy.startsWith("docker")}>{status?.docker.running ? "중지" : "시작"}</button>} />
          <ServiceRow name="Storage" value={status?.sharedReady ? "온라인 · 읽기/쓰기" : "연결 확인 필요"} active={Boolean(status?.sharedReady)} />
        </article>
      </section>

      <section className="content-grid">
        <article className="panel projects-panel">
          <div className="panel-header"><div><h2>프로젝트</h2><p>Git 프로젝트 작업 공간</p></div><span className="count">{projects.length}</span></div>
          <div className="project-list">
            {projects.map((project) => <article className="project-row" key={project.name}>
              <Folder className="project-folder-icon" size={22} strokeWidth={1.7} aria-hidden="true" />
              <span className="project-name"><strong>{project.name}</strong><small>{project.name === "mac-hub" ? "Unifying Storage 관리 웹" : project.path}</small><small>{project.git ? `${project.branch || "Git 저장소"} · ${project.changes ? `${project.changes}개 변경` : "변경 없음"}` : "일반 폴더"} · {relativeTime(project.updatedAt)}</small></span>
              <span className="project-actions"><button className="delete-project" aria-label={`${project.name} 프로젝트 삭제`} title="프로젝트 삭제" onClick={() => deleteProject(project)} disabled={project.name === "mac-hub" || busy === `delete:${project.name}`}><Trash2 size={17} strokeWidth={1.8} /></button></span>
            </article>)}
            {!projects.length && <Empty text="프로젝트가 없습니다." />}
          </div>
          <div className="forms">
            <form onSubmit={createProject}><label htmlFor="project-name">새 프로젝트</label><input id="project-name" value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="프로젝트 이름" pattern="[A-Za-z0-9._-]+" /><button disabled={busy === "create"}>생성</button></form>
            <form onSubmit={cloneProject}><label htmlFor="clone-url">GitHub 저장소 복제</label><input id="clone-url" value={cloneUrl} onChange={(event) => setCloneUrl(event.target.value)} placeholder="git@github.com:user/repo.git" /><button disabled={busy === "clone"}>Clone</button></form>
          </div>
        </article>

        <article className="panel memory-panel">
          <div className="panel-header"><div><h2>메모리</h2><p>macOS 메모리 압력 기준</p></div><strong>{status?.memory.percent ?? "—"}%</strong></div>
          <div className="memory-bar"><i style={{ width: `${status?.memory.percent || 0}%` }} /></div>
          <div className="memory-values"><span>{status ? storage(status.memory.used) : "—"} 사용</span><span>{status ? storage(status.memory.total - status.memory.used) : "—"} 사용 가능</span></div>
          <dl className="host-details"><div><dt>가동 시간</dt><dd>{status ? `${Math.floor(status.uptime / 3600)}시간` : "—"}</dd></div><div><dt>접속 주소</dt><dd>{status?.tailscale.ip || "—"}</dd></div></dl>
        </article>
      </section>

      <section className="panel files-panel" id="files">
        <div className="files-header">
          <div><h2>파일</h2></div>
        </div>
        {!status?.sharedReady && space === "shared" ? <div className="empty-storage"><strong>공유 저장소를 확인하는 중입니다.</strong><p>외장 SSD 연결 상태를 확인합니다.</p></div> : <>
          <div className="file-toolbar">
            <nav className="breadcrumbs" aria-label="현재 경로">{breadcrumbs.map((crumb, index) => <button key={crumb.path || "root"} onClick={() => goTo(crumb.path)}>{index > 0 && <span>/</span>}{crumb.name}</button>)}</nav>
            <div className="file-actions"><label className="file-search"><input aria-label="파일 검색" value={search} onChange={(event) => setSearch(event.target.value)} /><span aria-hidden="true"><Search size={18} strokeWidth={1.8} /></span></label><button className="new-folder" onClick={createFolder} disabled={busy === "folder"}>새 폴더</button><div className="upload-menu"><button className="upload-trigger" onClick={() => setUploadMenu((open) => !open)} aria-haspopup="menu" aria-expanded={uploadMenu}>업로드</button>{uploadMenu && <div className="upload-options" role="menu"><label role="menuitem">파일 선택<input type="file" multiple onChange={(event) => event.target.files && uploadFiles(event.target.files)} /></label><label role="menuitem">ZIP 폴더 선택<input type="file" accept=".zip,application/zip" onChange={(event) => event.target.files && uploadArchive(event.target.files)} /></label></div>}</div></div>
          </div>
          {renameEntry && <form className="rename-form" onSubmit={renameFile}><span><strong>{renameEntry.name}</strong> 이름 변경</span><input autoFocus value={renameName} onChange={(event) => setRenameName(event.target.value)} /><button disabled={busy === "rename"}>저장</button><button type="button" className="secondary" onClick={() => setRenameEntry(null)}>취소</button></form>}
          <div className="file-list">
            <div className="file-row file-head"><span>이름</span><span>크기</span><span>수정</span><span>작업</span></div>
            {path && <button className="file-row" onClick={() => goTo(path.split("/").slice(0, -1).join("/"))}><span>‹ 상위 폴더</span><span>—</span><span>—</span><span /></button>}
            {visibleFiles.map((entry) => {
              const protectedEntry = entry.path === "Developer" || entry.path === "Developer/mac-hub";
              return <div className="file-row" key={entry.path}><button className={`file-name${!entry.directory && previewKind(entry.name) ? " previewable" : ""}`} onClick={() => entry.directory ? goTo(entry.path) : openPreview(entry)}>{entry.directory ? <Folder className="entry-icon folder-entry-icon" size={22} strokeWidth={1.7} aria-hidden="true" /> : <File className="entry-icon" size={21} strokeWidth={1.7} aria-hidden="true" />}{entry.name}</button><span>{fileSize(entry.size)}</span><span>{relativeTime(entry.updatedAt)}</span><span className="row-actions">{entry.directory && <button className="icon-action project-action" onClick={() => addProject(entry)} disabled={busy === `project:${entry.path}`} aria-label={`${entry.name} 프로젝트로 추가`} title="프로젝트로 추가"><FolderUp size={18} strokeWidth={1.8} /></button>}<a className="icon-action download-action" href={downloadUrl(entry)} aria-label={`${entry.name} 다운로드`} title="다운로드"><Download size={18} strokeWidth={1.8} /></a><button className="icon-action edit-action" onClick={() => beginRename(entry)} aria-label={`${entry.name} 이름 변경`} title="이름 변경"><Pencil size={17} strokeWidth={1.8} /></button><button className="icon-action delete-file" onClick={() => deleteFile(entry)} disabled={protectedEntry || busy === `file-delete:${entry.path}`} aria-label={`${entry.name} 삭제`} title={protectedEntry ? "관리 폴더는 삭제할 수 없습니다" : "삭제"}><Trash2 size={17} strokeWidth={1.8} /></button></span></div>;
            })}
            {!visibleFiles.length && <Empty text={search ? "검색 결과가 없습니다." : "파일이 없습니다."} />}
          </div>
        </>}
      </section>
      {uploadProgress && <aside className={`upload-progress${uploadProgress.error ? " failed" : uploadProgress.done ? " complete" : ""}`} role="status" aria-live="polite">
        <div className="upload-progress-head"><div><span>{uploadProgress.done && !uploadProgress.error ? "완료" : uploadProgress.error ? "중단" : "업로드 중"}</span><strong>{uploadProgress.title}</strong></div>{uploadProgress.done ? <button onClick={() => setUploadProgress(null)} aria-label="업로드 상태 닫기"><X size={16} /></button> : <button className="cancel-upload" onClick={cancelUpload}>취소</button>}</div>
        <div className="upload-progress-value"><strong>{uploadProgress.percent}%</strong><span>{uploadProgress.error || uploadProgress.detail}</span></div>
        <div className="upload-progress-bar"><i style={{ width: `${uploadProgress.percent}%` }} /></div>
        <div className="upload-progress-meta"><span>{fileSize(uploadProgress.sent)} / {fileSize(uploadProgress.total)}</span><span>{uploadProgress.done ? (uploadProgress.error ? "확인 필요" : "저장 완료") : uploadProgress.speed ? `${fileSize(uploadProgress.speed)}/s · 약 ${Math.max(1, Math.ceil((uploadProgress.eta || 0) / 60))}분 남음` : "속도 계산 중"}</span></div>
      </aside>}
      {preview && <div className="preview-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setPreview(null); }}>
        <section className="preview-dialog" role="dialog" aria-modal="true" aria-labelledby="preview-title">
          <header className="preview-header"><span className="preview-type-icon">{preview.kind === "audio" ? <Music2 size={20} /> : <FileText size={20} />}</span><div><h2 id="preview-title">{preview.entry.name}</h2><p>{fileSize(preview.entry.size)} · {preview.kind === "audio" ? "오디오" : "텍스트"}</p></div><button className="preview-close" onClick={() => setPreview(null)} aria-label="미리보기 닫기"><X size={19} /></button></header>
          <div className={`preview-content ${preview.kind}`}>
            {preview.kind === "audio" ? <audio controls autoPlay preload="metadata" src={previewUrl(preview.entry)}>오디오 재생을 지원하지 않는 브라우저입니다.</audio> : preview.loading ? <div className="preview-message">불러오는 중…</div> : preview.error ? <div className="preview-message error">{preview.error}</div> : <pre>{preview.content}</pre>}
          </div>
          <footer className="preview-footer"><a href={downloadUrl(preview.entry)}><Download size={16} />다운로드</a></footer>
        </section>
      </div>}
    </main>
  );
}

function ServiceRow({ name, value, active, action }: { name: string; value: string; active: boolean; action?: React.ReactNode }) {
  return <div className="service-row"><span className={`status-dot ${active ? "ok" : "idle"}`} /><strong>{name}</strong><span>{value}</span>{action}</div>;
}

function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}
