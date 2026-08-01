"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type { EditorClip, EditorProject, EditorTrack, JobState, JobStatus } from "@/lib/types";

const MIN_CLIP_DURATION = 0.25;

const statusLabels: Record<JobStatus, string> = {
  received: "Recebido",
  transcribing: "Transcrevendo",
  planning: "Planejando",
  searching: "Pesquisando B-roll",
  downloading: "Preparando mídia",
  rendering: "Renderizando",
  awaiting_approval: "Pronto para revisar",
  exporting: "Exportando",
  completed: "Exportado",
  failed: "Falhou",
};

function formatTime(seconds = 0) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const rest = Math.floor(safe % 60).toString().padStart(2, "0");
  return hours > 0 ? `${hours}:${minutes.toString().padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

function mediaUrl(jobId: string, fileName?: string) {
  if (!fileName) return "";
  const encoded = fileName.split("/").map((part) => encodeURIComponent(part)).join("/");
  return `/api/jobs/${jobId}/media/${encoded}`;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function activeAt(clip: EditorClip, time: number) {
  return time >= clip.start && time < clip.start + clip.duration;
}

type GestureMode = "move" | "left" | "right";

interface Gesture {
  clipId: string;
  mode: GestureMode;
  startX: number;
  zoom: number;
  project: EditorProject;
}

function transformClip(project: EditorProject, clipId: string, mode: GestureMode, delta: number) {
  return {
    ...project,
    clips: project.clips.map((clip) => {
      if (clip.id !== clipId || clip.trackId !== "V1") return clip;
      if (mode === "move") {
        return { ...clip, start: clamp(clip.start + delta, 0, Math.max(0, project.duration - clip.duration)) };
      }
      if (mode === "left") {
        const nextStart = clamp(clip.start + delta, 0, clip.start + clip.duration - MIN_CLIP_DURATION);
        const offset = nextStart - clip.start;
        return {
          ...clip,
          start: nextStart,
          duration: clip.duration - offset,
          sourceStart: clip.sourceStart + offset,
        };
      }
      return {
        ...clip,
        duration: clamp(clip.duration + delta, MIN_CLIP_DURATION, project.duration - clip.start),
      };
    }),
  };
}

export default function EditorWorkspace() {
  const [jobId, setJobId] = useState<string | null>(null);
  const [resolvingJob, setResolvingJob] = useState(true);
  const [job, setJob] = useState<JobState | null>(null);
  const [project, setProject] = useState<EditorProject | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(8);
  const [dirty, setDirty] = useState(false);
  const [history, setHistory] = useState<EditorProject[]>([]);
  const [future, setFuture] = useState<EditorProject[]>([]);
  const [saving, setSaving] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [creatingDraft, setCreatingDraft] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [showSources, setShowSources] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const videoRefs = useRef<Record<string, HTMLVideoElement>>({});
  const gestureRef = useRef<Gesture | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const narrationInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const queryJob = new URLSearchParams(window.location.search).get("job");
      if (queryJob) {
        setJobId(queryJob);
        setResolvingJob(false);
        return;
      }
      void fetch("/api/jobs?latest=1", { cache: "no-store" })
        .then(async (response) => (response.ok ? (await response.json()) as JobState : null))
        .then((latest) => setJobId(latest?.id || null))
        .catch(() => setJobId(null))
        .finally(() => setResolvingJob(false));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const loadProject = useCallback(async (id: string) => {
    setError("");
    const [jobResponse, projectResponse] = await Promise.all([
      fetch(`/api/jobs/${id}`, { cache: "no-store" }),
      fetch(`/api/jobs/${id}/editor`, { cache: "no-store" }),
    ]);
    const jobData = (await jobResponse.json()) as JobState & { error?: string };
    const projectData = (await projectResponse.json()) as EditorProject & { error?: string };
    if (!jobResponse.ok) throw new Error(jobData.error || "Job não encontrado.");
    if (!projectResponse.ok) throw new Error(projectData.error || "Projeto do editor não encontrado.");
    setJob(jobData);
    setProject(projectData);
    setCurrentTime(0);
  }, []);

  useEffect(() => {
    if (!jobId) return;
    const timer = window.setTimeout(() => {
      void loadProject(jobId).catch((loadError: unknown) => {
        setError(loadError instanceof Error ? loadError.message : "Não foi possível abrir o editor.");
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [jobId, loadProject]);

  useEffect(() => {
    if (!jobId || !job || ["awaiting_approval", "completed", "failed"].includes(job.status)) return;
    const timer = window.setInterval(() => {
      void fetch(`/api/jobs/${jobId}`, { cache: "no-store" })
        .then(async (response) => (response.ok ? (await response.json()) as JobState : null))
        .then((nextJob) => {
          if (!nextJob) return;
          setJob(nextJob);
          if (["awaiting_approval", "completed", "failed"].includes(nextJob.status)) setRendering(false);
        })
        .catch(() => undefined);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [jobId, job]);

  useEffect(() => {
    if (!playing || !project) return;
    const timer = window.setInterval(() => {
      setCurrentTime((time) => {
        const next = time + 0.05;
        if (next >= project.duration) {
          setPlaying(false);
          return project.duration;
        }
        return next;
      });
    }, 50);
    return () => window.clearInterval(timer);
  }, [playing, project]);

  const selectedClip = useMemo(
    () => project?.clips.find((clip) => clip.id === selectedClipId) || null,
    [project, selectedClipId],
  );
  const selectedUnit = useMemo(
    () => job?.visualUnits?.find((unit) => unit.id === selectedClip?.unitId),
    [job, selectedClip],
  );
  const activeVideoClips = useMemo(
    () => (project?.clips || []).filter((clip) => clip.assetType === "video" && activeAt(clip, currentTime)),
    [project, currentTime],
  );
  const timelineWidth = project ? Math.max(920, project.duration * zoom) : 920;
  const tickStep = project && project.duration > 180 ? 20 : project && project.duration > 90 ? 10 : 5;
  const ticks = project ? Array.from({ length: Math.ceil(project.duration / tickStep) + 1 }, (_, index) => Math.min(index * tickStep, project.duration)) : [];
  const audioClip = project?.clips.find((clip) => clip.trackId === "A1");

  const saveProject = useCallback(async (nextProject: EditorProject) => {
    if (!jobId) return;
    setSaving(true);
    const response = await fetch(`/api/jobs/${jobId}/editor`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: nextProject }),
    });
    const data = (await response.json()) as { error?: string };
    setSaving(false);
    if (!response.ok) {
      setNotice(data.error || "Não foi possível salvar o projeto.");
      return false;
    }
    setDirty(false);
    setNotice("Projeto salvo.");
    return true;
  }, [jobId]);

  const scheduleSave = useCallback((nextProject: EditorProject) => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => void saveProject(nextProject), 850);
  }, [saveProject]);

  function mutateProject(updater: (current: EditorProject) => EditorProject) {
    if (!project) return;
    const next = updater(project);
    setHistory((items) => [...items.slice(-39), project]);
    setFuture([]);
    setProject(next);
    setDirty(true);
    scheduleSave(next);
  }

  function undo() {
    if (!project || history.length === 0) return;
    const previous = history[history.length - 1];
    setHistory((items) => items.slice(0, -1));
    setFuture((items) => [project, ...items].slice(0, 40));
    setProject(previous);
    setDirty(true);
    scheduleSave(previous);
  }

  function redo() {
    if (!project || future.length === 0) return;
    const next = future[0];
    setFuture((items) => items.slice(1));
    setHistory((items) => [...items.slice(-39), project]);
    setProject(next);
    setDirty(true);
    scheduleSave(next);
  }

  useEffect(() => {
    const audio = audioRef.current;
    if (audio && project && audioClip) {
      const target = clamp(currentTime - audioClip.start + audioClip.sourceStart, 0, audioClip.sourceDuration);
      if (Math.abs(audio.currentTime - target) > 0.15) audio.currentTime = target;
      if (playing && !project.tracks.find((track) => track.id === "A1")?.muted) {
        void audio.play().catch(() => undefined);
      } else {
        audio.pause();
      }
    }

    Object.entries(videoRefs.current).forEach(([clipId, video]) => {
      const clip = project?.clips.find((item) => item.id === clipId);
      if (!clip || !activeAt(clip, currentTime)) {
        video.pause();
        return;
      }
      const target = clamp(currentTime - clip.start + clip.sourceStart, 0, clip.sourceDuration);
      if (Math.abs(video.currentTime - target) > 0.18) video.currentTime = target;
      if (playing) void video.play().catch(() => undefined);
      else video.pause();
    });
  }, [audioClip, currentTime, playing, project]);

  function togglePlaying() {
    if (!project) return;
    if (currentTime >= project.duration - 0.05) setCurrentTime(0);
    setPlaying((value) => !value);
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || (event.target instanceof HTMLInputElement) || (event.target instanceof HTMLTextAreaElement)) return;
      event.preventDefault();
      if (!project) return;
      if (currentTime >= project.duration - 0.05) setCurrentTime(0);
      setPlaying((value) => !value);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [currentTime, project]);

  function seek(event: ReactPointerEvent<HTMLDivElement>) {
    if (!project) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setCurrentTime(clamp((event.clientX - rect.left) / zoom, 0, project.duration));
  }

  function startGesture(event: ReactPointerEvent<HTMLElement>, clip: EditorClip, mode: GestureMode) {
    if (!project || clip.trackId !== "V1" || project.tracks.find((track) => track.id === clip.trackId)?.locked) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedClipId(clip.id);
    setHistory((items) => [...items.slice(-39), project]);
    setFuture([]);
    gestureRef.current = { clipId: clip.id, mode, startX: event.clientX, zoom, project };

    const onMove = (moveEvent: PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture) return;
      const delta = (moveEvent.clientX - gesture.startX) / gesture.zoom;
      const next = transformClip(gesture.project, gesture.clipId, gesture.mode, delta);
      setProject(next);
      setDirty(true);
      scheduleSave(next);
    };
    const onUp = () => {
      gestureRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function splitSelected() {
    if (!project || !selectedClip || selectedClip.trackId !== "V1") return;
    const cut = currentTime;
    if (cut <= selectedClip.start + MIN_CLIP_DURATION || cut >= selectedClip.start + selectedClip.duration - MIN_CLIP_DURATION) {
      setNotice("Coloque o playhead dentro de um clipe para dividi-lo.");
      return;
    }
    const firstDuration = cut - selectedClip.start;
    const secondDuration = selectedClip.duration - firstDuration;
    const second: EditorClip = {
      ...selectedClip,
      id: `${selectedClip.id}-b`,
      start: cut,
      duration: secondDuration,
      sourceStart: selectedClip.sourceStart + firstDuration,
      sourceDuration: Math.max(MIN_CLIP_DURATION, selectedClip.sourceDuration - firstDuration),
      label: `${selectedClip.label} · continuação`,
    };
    mutateProject((current) => ({
      ...current,
      clips: current.clips.flatMap((clip) => clip.id === selectedClip.id
        ? [{ ...clip, duration: firstDuration, sourceDuration: Math.max(MIN_CLIP_DURATION, firstDuration) }, second]
        : [clip]),
    }));
    setSelectedClipId(second.id);
  }

  function deleteSelected() {
    if (!project || !selectedClip || selectedClip.trackId === "A1") return;
    mutateProject((current) => ({ ...current, clips: current.clips.filter((clip) => clip.id !== selectedClip.id) }));
    setSelectedClipId(null);
    setNotice("Trecho removido da timeline.");
  }

  function updateSelectedField(field: "start" | "duration", value: number) {
    if (!selectedClip || !Number.isFinite(value) || selectedClip.trackId !== "V1") return;
    mutateProject((current) => ({
      ...current,
      clips: current.clips.map((clip) => {
        if (clip.id !== selectedClip.id) return clip;
        if (field === "start") return { ...clip, start: clamp(value, 0, Math.max(0, current.duration - clip.duration)) };
        return { ...clip, duration: clamp(value, MIN_CLIP_DURATION, current.duration - clip.start) };
      }),
    }));
  }

  function toggleTrack(trackId: EditorTrack["id"], field: "muted" | "locked") {
    mutateProject((current) => ({
      ...current,
      tracks: current.tracks.map((track) => track.id === trackId ? { ...track, [field]: !track[field] } : track),
    }));
  }

  async function renderPreview() {
    if (!jobId) return;
    if (dirty && project && !(await saveProject(project))) return;
    setRendering(true);
    setNotice("Atualizando o preview com a timeline editada…");
    const response = await fetch(`/api/jobs/${jobId}/editor/render`, { method: "POST" });
    const data = (await response.json()) as { error?: string };
    if (!response.ok) {
      setRendering(false);
      setNotice(data.error || "Não foi possível renderizar o preview.");
      return;
    }
    setJob((current) => current ? { ...current, status: "rendering", progress: 90 } : current);
  }

  async function exportVideo() {
    if (!jobId) return;
    if (dirty && project && !(await saveProject(project))) return;
    const response = await fetch(`/api/jobs/${jobId}/approve`, { method: "POST" });
    const data = (await response.json()) as { error?: string };
    if (!response.ok) {
      setNotice(data.error || "Não foi possível iniciar a exportação.");
      return;
    }
    setJob((current) => current ? { ...current, status: "exporting", progress: 5 } : current);
    setNotice("Exportação iniciada. Você pode continuar revisando a timeline.");
  }

  async function createDraftFromEditor(event: ChangeEvent<HTMLInputElement>) {
    const audio = event.target.files?.[0];
    event.target.value = "";
    if (!audio) return;
    setCreatingDraft(true);
    setNotice("Enviando a nova narração para o pipeline…");
    const formData = new FormData();
    formData.set("audio", audio);
    formData.set("brief", job?.brief || "");
    try {
      const response = await fetch("/api/jobs", { method: "POST", body: formData });
      const data = (await response.json()) as JobState & { error?: string };
      if (!response.ok) {
        setNotice(data.error || "Não foi possível criar o novo rascunho.");
        return;
      }
      window.location.assign(`/editor?job=${data.id}`);
    } catch {
      setNotice("Não foi possível enviar a nova narração.");
    } finally {
      setCreatingDraft(false);
    }
  }

  if (!jobId && resolvingJob) {
    return <main className="editor-loading"><div className="loading-orbit">✦</div><p>Preparando a sala de edição…</p><small>Localizando o último projeto.</small></main>;
  }

  if (!jobId) {
    return <main className="editor-loading"><div className="loading-orbit">✦</div><p>Nenhum job encontrado.</p><Link href="/">Criar uma narração</Link></main>;
  }

  if (error) {
    return <main className="editor-loading"><div className="loading-orbit warning">!</div><p>{error}</p><Link href="/">Voltar para o início</Link></main>;
  }

  if (!job || !project) {
    return <main className="editor-loading"><div className="loading-orbit">✦</div><p>Preparando a sala de edição…</p><small>Carregando timeline, narração e camadas.</small></main>;
  }

  const isExported = job.status === "completed" && Boolean(job.media?.final);
  const previewFallback = job.media?.preview ? mediaUrl(job.id, job.media.preview) : "";

  return (
    <main className="editor-app">
      <header className="editor-topbar">
        <div className="editor-brand">
          <Link href="/" className="editor-back">←</Link>
          <span className="brand-mark small">✦</span>
          <div>
            <p className="eyebrow">EDITORIA · LOCAL NLE</p>
            <strong>{project.title}</strong>
          </div>
        </div>
        <div className="editor-modebar" aria-label="Workspace"><span className="active">EDIT</span><span>AI ASSIST</span><span>DELIVER</span></div>
        <div className="editor-top-actions">
          <span className={`editor-status status-${job.status}`}><span className="status-dot" />{statusLabels[job.status]}</span>
          <button className="icon-button top-icon" onClick={undo} disabled={history.length === 0} title="Desfazer">↶</button>
          <button className="icon-button top-icon" onClick={redo} disabled={future.length === 0} title="Refazer">↷</button>
          <button className="ghost-button" onClick={() => void saveProject(project)} disabled={saving}>{saving ? "Salvando…" : dirty ? "Salvar alterações" : "Salvo"}</button>
          <button className="primary-small" onClick={() => void renderPreview()} disabled={rendering || saving}>{rendering ? "Renderizando…" : "Atualizar preview"}</button>
          <button className="export-button" onClick={() => void exportVideo()} disabled={job.status === "exporting" || rendering}>{isExported ? "Exportar novamente" : "Exportar vídeo"}<span>↗</span></button>
          {isExported && job.media?.final && <a className="export-download" href={mediaUrl(job.id, job.media.final)} download="editoria-final.mp4">Baixar final ↓</a>}
        </div>
      </header>

      <div className="editor-layout">
        <aside className="editor-sidebar left-sidebar">
          <div className="sidebar-heading"><span className="eyebrow">PROJECT</span><span className="ai-spark">✦</span></div>
          <div className="ai-card">
            <div className="ai-card-head"><span className="ai-card-label">AI ASSIST</span><kbd>⌘K</kbd></div>
            <strong>Rascunho em edição</strong>
            <p>A inteligência artificial organizou o primeiro corte a partir da narração.</p>
            <div className="ai-status-row"><span className="ai-live-dot" /><small>{statusLabels[job.status]}</small><b>{formatTime(project.duration)}</b></div>
            <div className="ai-card-progress"><span style={{ width: `${Math.min(100, job.progress)}%` }} /></div>
          </div>

          <div className="sidebar-section">
            <div className="sidebar-section-heading"><span>MEDIA</span><span className="tiny-count">{project.clips.filter((clip) => clip.trackId === "V1").length}</span></div>
            <div className="project-file"><span className="file-icon audio">◒</span><div><strong>{job.originalAudioName}</strong><small>Narração principal · {formatTime(project.duration)}</small></div></div>
            <input ref={narrationInputRef} className="sidebar-upload" type="file" accept="audio/*,.m4a,.mp3,.wav,.webm" onChange={createDraftFromEditor} />
            <button className="sidebar-action" onClick={() => narrationInputRef.current?.click()} disabled={creatingDraft}>＋ {creatingDraft ? "Enviando narração…" : "Nova narração"}</button>
          </div>

          <div className="sidebar-section">
            <div className="sidebar-section-heading"><span>AI ASSIST</span><span className="new-pill">ACTIVE</span></div>
            <button className="sidebar-action" onClick={() => narrationInputRef.current?.click()} disabled={creatingDraft}><span>✦</span> {creatingDraft ? "Gerando rascunho…" : "Gerar novo rascunho"}</button>
            <button className="sidebar-action" onClick={() => setShowSources((value) => !value)}><span>⌁</span> {showSources ? "Ocultar fontes" : "Ver fontes encontradas"}</button>
          </div>

          {showSources && (
            <div className="source-list">
              {(job.candidates || []).slice(0, 8).map((candidate) => <a key={candidate.id} href={candidate.url} target="_blank" rel="noreferrer"><span>↗</span><span>{candidate.title}</span></a>)}
              {(!job.candidates || job.candidates.length === 0) && <small>Nenhuma fonte registrada.</small>}
            </div>
          )}

          <div className="sidebar-footnote"><span className="pulse" /> Gemini 3.6 Flash<br /><small>Projeto salvo localmente</small></div>
        </aside>

        <section className="editor-center">
          <div className="preview-toolbar">
            <div><span className="eyebrow">PROGRAM MONITOR</span><strong>{formatTime(currentTime)} <span>/ {formatTime(project.duration)}</span></strong></div>
            <div className="preview-toolbar-actions"><span className="keyboard-hint">SPACE</span><span>reproduzir</span><button className="icon-button" onClick={() => setCurrentTime(0)} title="Voltar ao início">↶</button><button className="play-button" onClick={togglePlaying}>{playing ? "Ⅱ" : "▶"}</button></div>
          </div>
          <div className="preview-stage-wrap">
            <div className="preview-stage">
              {activeVideoClips.length > 0 ? activeVideoClips.map((clip) => (
                <video
                  key={clip.id}
                  ref={(element) => { if (element) videoRefs.current[clip.id] = element; else delete videoRefs.current[clip.id]; }}
                  className="preview-video"
                  src={jobId ? mediaUrl(jobId, clip.assetFileName) : ""}
                  muted
                  playsInline
                  preload="auto"
                />
              )) : previewFallback ? <video className="preview-video preview-fallback" src={previewFallback} muted playsInline /> : <div className="preview-placeholder"><span>✦</span><p>Selecione um trecho para começar.</p></div>}
              <div className="preview-vignette" />
              <div className="preview-meta"><span>16:9</span><span>{activeVideoClips[0]?.label || "V1 · sem sinal"}</span></div>
            </div>
          </div>
          {audioClip?.assetFileName && jobId && <audio ref={audioRef} src={mediaUrl(jobId, audioClip.assetFileName)} preload="auto" />}

          <div className="timeline-panel">
            <div className="timeline-heading">
              <div><span className="eyebrow">TIMELINE</span><strong>{project.clips.length - 1} clips · {project.tracks.length} camadas</strong></div>
              <div className="timeline-tools"><button className="icon-button" onClick={() => setZoom((value) => clamp(value - 1, 4, 18))}>−</button><span>{Math.round(zoom * 10)}%</span><button className="icon-button" onClick={() => setZoom((value) => clamp(value + 1, 4, 18))}>＋</button><button className="icon-button" onClick={splitSelected} title="Dividir no playhead">✂</button></div>
            </div>
            <div className="timeline-body">
              <div className="timeline-label-column">
                <div className="ruler-spacer" />
                {project.tracks.map((track) => <div className={`track-label track-${track.id.toLowerCase()}`} key={track.id}><div><strong>{track.id}</strong><small>{track.name}</small></div><div className="track-label-actions"><button className={track.muted ? "active" : ""} onClick={() => toggleTrack(track.id, "muted")} title="Silenciar">{track.kind === "audio" ? "◖" : "◌"}</button><button className={track.locked ? "active" : ""} onClick={() => toggleTrack(track.id, "locked")} title="Bloquear">{track.locked ? "▣" : "□"}</button></div></div>)}
              </div>
              <div className="timeline-scroll">
                <div className="timeline-canvas" style={{ width: timelineWidth }} onPointerDown={seek}>
                  <div className="timeline-ruler">{ticks.map((tick) => <span key={tick} style={{ left: tick * zoom }}>{formatTime(tick)}</span>)}</div>
                  <div className="timeline-grid-lines">{ticks.map((tick) => <i key={tick} style={{ left: tick * zoom }} />)}</div>
                  <div className="timeline-playhead" style={{ left: currentTime * zoom }}><span /></div>
                  {project.tracks.map((track) => {
                    const clips = project.clips.filter((clip) => clip.trackId === track.id);
                    return <div className={`track-lane track-lane-${track.id.toLowerCase()}`} key={track.id}>{clips.map((clip) => {
                      const selected = clip.id === selectedClipId;
                      const clipStyle = { left: clip.start * zoom, width: Math.max(18, clip.duration * zoom) } as CSSProperties;
                      return <div className={`timeline-clip clip-${track.id.toLowerCase()} ${selected ? "selected" : ""}`} key={clip.id} style={clipStyle} onPointerDown={(event) => startGesture(event, clip, "move")} onClick={(event) => { event.stopPropagation(); setSelectedClipId(clip.id); }} title={clip.label}>
                        {selected && track.id === "V1" && <button className="trim-handle left" onPointerDown={(event) => startGesture(event, clip, "left")} aria-label="Ajustar início" />}
                        <span className="clip-role">{track.kind === "audio" ? "VOICE" : "B-ROLL"}</span><span className="clip-wave">{track.kind === "audio" ? "▂▃▅▃▂▅▃▂" : ""}</span><strong>{clip.unitId || clip.label}</strong><small>{formatTime(clip.duration)}</small>
                        {selected && track.id === "V1" && <button className="trim-handle right" onPointerDown={(event) => startGesture(event, clip, "right")} aria-label="Ajustar fim" />}
                      </div>;
                    })}</div>;
                  })}
                </div>
              </div>
            </div>
          </div>
        </section>

        <aside className="editor-sidebar inspector-sidebar">
          <div className="sidebar-heading"><span className="eyebrow">INSPECTOR</span><span className="inspector-icon">⌘</span></div>
          <div className="inspector-mode"><span className="active">CLIP</span><span>AI NOTE</span></div>
          {!selectedClip ? <div className="inspector-empty"><span>⌁</span><strong>Selecione um trecho</strong><p>Os controles de corte, origem e duração aparecerão aqui.</p></div> : (
            <div className="inspector-content">
              <div className="inspector-title"><span className={`inspector-type type-${selectedClip.trackId.toLowerCase()}`}>{selectedClip.trackId}</span><div><strong>{selectedClip.label}</strong><small>{selectedClip.sourceTitle || "Mídia local do rascunho"}</small></div></div>
              <div className="inspector-fields"><label>INÍCIO<input type="number" min="0" step="0.1" value={selectedClip.start.toFixed(1)} onChange={(event) => updateSelectedField("start", Number(event.target.value))} /></label><label>DURAÇÃO<input type="number" min={MIN_CLIP_DURATION} step="0.1" value={selectedClip.duration.toFixed(1)} onChange={(event) => updateSelectedField("duration", Number(event.target.value))} /></label></div>
              <div className="inspector-divider" />
              <div className="inspector-block"><span className="eyebrow">INTENÇÃO VISUAL</span><p>{selectedUnit?.visualBrief || "Trecho de apoio neutro da timeline."}</p>{selectedUnit && <div className="confidence-row"><span>Confiança da IA</span><strong>{Math.round(selectedUnit.confidence * 100)}%</strong></div>}</div>
              <div className="inspector-block"><span className="eyebrow">NARRAÇÃO</span><p className="narration-quote">{selectedUnit?.narration || "Este trecho cobre uma transição da narração."}</p></div>
              {selectedClip.sourceUrl && <a className="source-link" href={selectedClip.sourceUrl} target="_blank" rel="noreferrer">Abrir fonte original ↗</a>}
              <div className="inspector-actions"><button onClick={splitSelected}>✂ Dividir no playhead</button><button className="danger-action" onClick={deleteSelected}>Excluir trecho</button></div>
            </div>
          )}
          <div className="inspector-bottom"><span className="eyebrow">ATALHOS</span><div><span><kbd>Space</kbd> reproduzir</span><span><kbd>Click</kbd> selecionar</span><span><kbd>Drag</kbd> mover ou aparar</span></div></div>
        </aside>
      </div>

      {notice && <button className="editor-toast" onClick={() => setNotice("")}>{notice}<span>×</span></button>}
    </main>
  );
}
