"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import CreativeBriefForm from "@/components/creative-brief-form";
import type { EditorClip, EditorProject, EditorTrack, JobState, JobStatus } from "@/lib/types";

const MIN_CLIP_DURATION = 0.25;

const statusLabels: Record<JobStatus, string> = {
  received: "Recebido",
  transcribing: "Transcrevendo",
  awaiting_direction: "Defina a direção",
  planning: "Planejando",
  searching: "Pesquisando B-roll",
  downloading: "Preparando mídia",
  rendering: "Renderizando",
  awaiting_approval: "Pronto para revisar",
  exporting: "Exportando",
  completed: "Exportado",
  failed: "Falhou",
};

const processingStages: Array<{ label: string; threshold: number; statuses: JobStatus[] }> = [
  { label: "Narração", threshold: 10, statuses: ["received", "transcribing"] },
  { label: "Direção criativa", threshold: 20, statuses: ["planning"] },
  { label: "Busca e B-roll", threshold: 45, statuses: ["searching", "downloading"] },
  { label: "Preview", threshold: 86, statuses: ["rendering", "awaiting_approval", "completed"] },
];

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

function ProcessingScreen({
  job,
  title,
  message,
  variant = "loading",
}: {
  job?: JobState | null;
  title: string;
  message: string;
  variant?: "loading" | "error";
}) {
  const progress = job ? clamp(Number(job.progress) || 0, 0, 100) : 0;
  const activeStage = job ? processingStages.findIndex((stage) => stage.statuses.includes(job.status)) : 0;
  const activeStageIndex = activeStage >= 0 ? activeStage : progress >= 86 ? processingStages.length - 1 : 0;
  const isError = variant === "error";
  const isComplete = job?.status === "awaiting_approval" || job?.status === "completed";

  return (
    <main className="editor-app editor-processing-shell">
      <header className="editor-topbar">
        <div className="editor-brand">
          <Link href="/" className="editor-back">←</Link>
          <span className="brand-mark small">✦</span>
          <div>
            <p className="eyebrow">EDITORIA · LOCAL NLE</p>
            <strong>{job?.originalAudioName || "Novo projeto"}</strong>
          </div>
        </div>
        <div className="editor-top-actions">
          <span className={`editor-status ${isError ? "status-failed" : "status-rendering"}`}>
            <span className="status-dot" />{isError ? "Atenção" : "Processando"}
          </span>
        </div>
      </header>

      <section className="processing-frame">
        <div className="processing-card">
          <div className="processing-card-head">
            <div className={`processing-mark ${isError ? "warning" : ""}`}>{isError ? "!" : "✦"}</div>
            <div>
              <p className="eyebrow">{isError ? "EDITORIA · ERRO" : "EDITORIA · CONSTRUINDO O RASCUNHO"}</p>
              <h1>{title}</h1>
              <p className="processing-message">{message}</p>
            </div>
          </div>

          <div className="processing-progress-head">
            <span>{isError ? "Processamento interrompido" : "Progresso do projeto"}</span>
            <strong>{isError ? "—" : job ? `${progress}%` : "Conectando…"}</strong>
          </div>
          <div className={`processing-progress-track ${isError ? "error" : ""}`}>
            {isError ? <span style={{ width: "100%" }} /> : job ? <span style={{ width: `${progress}%` }} /> : <span className="indeterminate" />}
          </div>

          <div className="processing-status-line">
            <span><i className={isError ? "error" : ""} />{job ? statusLabels[job.status] : "Sincronizando o job"}</span>
            <span>{isError ? "Revise a mensagem acima" : "Atualização automática a cada poucos segundos"}</span>
          </div>

          <div className="processing-stages">
            {processingStages.map((stage, index) => {
              const done = Boolean(job && (index < activeStageIndex || isComplete || (index === processingStages.length - 1 && progress >= 100)));
              const current = !isError && index === activeStageIndex && !done;
              return <div className={`processing-stage ${done ? "done" : ""} ${current ? "current" : ""}`} key={stage.label}><span>{done ? "✓" : index + 1}</span><div><strong>{stage.label}</strong><small>{done ? "Concluído" : current ? "Em andamento" : "A seguir"}</small></div></div>;
            })}
          </div>

          <div className="processing-editor-skeleton" aria-hidden="true">
            <div className="processing-skeleton-monitor"><span>PROGRAM MONITOR</span><i>⌁</i></div>
            <div className="processing-skeleton-timeline"><span>TIMELINE</span><i /><i /><i /></div>
          </div>
          <p className="processing-footnote">Você pode deixar esta janela aberta. Assim que a timeline estiver pronta, o editor será aberto automaticamente.</p>
          {isError && <Link className="processing-back-link" href="/">Voltar para o início</Link>}
        </div>
      </section>
    </main>
  );
}

function activeAt(clip: EditorClip, time: number) {
  return time >= clip.start && time < clip.start + clip.duration;
}

type GestureMode = "move" | "left" | "right";
type RecorderState = "idle" | "recording" | "ready";

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
  const [showRecorder, setShowRecorder] = useState(false);
  const [recorderState, setRecorderState] = useState<RecorderState>("idle");
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [recordedAudio, setRecordedAudio] = useState<Blob | null>(null);
  const [recordedAudioUrl, setRecordedAudioUrl] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [showSources, setShowSources] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const videoRefs = useRef<Record<string, HTMLVideoElement>>({});
  const gestureRef = useRef<Gesture | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const narrationInputRef = useRef<HTMLInputElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recorderStreamRef = useRef<MediaStream | null>(null);
  const recorderChunksRef = useRef<Blob[]>([]);
  const recorderTimerRef = useRef<number | null>(null);

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

  useEffect(() => () => {
    if (recorderTimerRef.current) window.clearInterval(recorderTimerRef.current);
    recorderStreamRef.current?.getTracks().forEach((track) => track.stop());
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.onstop = null;
      mediaRecorderRef.current.stop();
    }
    if (recordedAudioUrl) URL.revokeObjectURL(recordedAudioUrl);
  }, [recordedAudioUrl]);

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
          if (nextJob.timeline || nextJob.editorProject) {
            void fetch(`/api/jobs/${jobId}/editor`, { cache: "no-store" })
              .then(async (projectResponse) => (projectResponse.ok ? (await projectResponse.json()) as EditorProject : null))
              .then((nextProject) => { if (nextProject) setProject(nextProject); })
              .catch(() => undefined);
          }
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
  const activeSourceVideoClips = useMemo(
    () => activeVideoClips.filter((clip) => Boolean(clip.sourceUrl)),
    [activeVideoClips],
  );
  const activeMissingSourceClips = useMemo(
    () => activeVideoClips.filter((clip) => !clip.sourceUrl),
    [activeVideoClips],
  );
  const timelineWidth = project ? Math.max(920, project.duration * zoom) : 920;
  const tickStep = project && project.duration > 180 ? 20 : project && project.duration > 90 ? 10 : 5;
  const ticks = project ? Array.from({ length: Math.ceil(project.duration / tickStep) + 1 }, (_, index) => Math.min(index * tickStep, project.duration)) : [];
  const audioClip = project?.clips.find((clip) => clip.trackId === "A1");
  const missingSourceCount = project?.clips.filter((clip) => clip.trackId === "V1" && !clip.sourceUrl).length || 0;

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

  function clearRecorderTimer() {
    if (recorderTimerRef.current) window.clearInterval(recorderTimerRef.current);
    recorderTimerRef.current = null;
  }

  function releaseRecorderStream() {
    recorderStreamRef.current?.getTracks().forEach((track) => track.stop());
    recorderStreamRef.current = null;
  }

  function discardRecordedAudio() {
    clearRecorderTimer();
    releaseRecorderStream();
    if (recordedAudioUrl) URL.revokeObjectURL(recordedAudioUrl);
    setRecordedAudio(null);
    setRecordedAudioUrl("");
    setRecordingSeconds(0);
    setRecorderState("idle");
  }

  async function startAudioRecording() {
    if (recorderState === "recording") return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setNotice("Este navegador não oferece gravação de áudio pelo microfone.");
      return;
    }

    discardRecordedAudio();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recorderStreamRef.current = stream;
      recorderChunksRef.current = [];
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
        .find((candidate) => MediaRecorder.isTypeSupported(candidate));
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recorderChunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        clearRecorderTimer();
        releaseRecorderStream();
        const blob = new Blob(recorderChunksRef.current, { type: recorder.mimeType || "audio/webm" });
        if (blob.size === 0) {
          setRecorderState("idle");
          setNotice("A gravação ficou vazia. Tente novamente.");
          return;
        }
        setRecordedAudio(blob);
        setRecordedAudioUrl(URL.createObjectURL(blob));
        setRecorderState("ready");
      };
      recorder.onerror = () => {
        clearRecorderTimer();
        releaseRecorderStream();
        setRecorderState("idle");
        setNotice("Não foi possível concluir a gravação.");
      };
      recorder.start(250);
      setRecordingSeconds(0);
      setRecorderState("recording");
      recorderTimerRef.current = window.setInterval(() => setRecordingSeconds((value) => value + 1), 1000);
    } catch {
      releaseRecorderStream();
      setRecorderState("idle");
      setNotice("Permita o acesso ao microfone para gravar a narração.");
    }
  }

  function stopAudioRecording() {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    clearRecorderTimer();
    recorder.stop();
  }

  function useRecordedAudio() {
    if (!recordedAudio) return;
    const extension = recordedAudio.type.includes("mp4") ? "m4a" : "webm";
    const file = new File([recordedAudio], `narracao-gravada-${Date.now()}.${extension}`, {
      type: recordedAudio.type || "audio/webm",
    });
    void submitNarrationAudio(file);
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

  async function submitNarrationAudio(audio: File) {
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

  function createDraftFromEditor(event: ChangeEvent<HTMLInputElement>) {
    const audio = event.target.files?.[0];
    event.target.value = "";
    if (audio) void submitNarrationAudio(audio);
  }

  if (!jobId && resolvingJob) {
    return <ProcessingScreen title="Preparando a sala de edição" message="Localizando o último projeto salvo." />;
  }

  if (!jobId) {
    return <main className="editor-loading"><div className="loading-orbit">✦</div><p>Nenhum job encontrado.</p><Link href="/">Criar uma narração</Link></main>;
  }

  if (error) {
    return <ProcessingScreen title="Não foi possível abrir o editor" message={error} variant="error" />;
  }

  if (!job || !project) {
    return <ProcessingScreen job={job} title="Preparando a sala de edição" message={job?.message || "Carregando timeline, narração e camadas."} />;
  }

  if (job.status === "awaiting_direction" && job.creativeBrief) {
    return (
      <main className="editor-app creative-brief-app">
        <header className="editor-topbar">
          <div className="editor-brand">
            <Link href="/" className="editor-back">←</Link>
            <span className="brand-mark small">✦</span>
            <div>
              <p className="eyebrow">EDITORIA · DIREÇÃO CRIATIVA</p>
              <strong>{job.originalAudioName}</strong>
            </div>
          </div>
          <div className="editor-top-actions">
            <span className={`editor-status status-${job.status}`}><span className="status-dot" />{statusLabels[job.status]}</span>
          </div>
        </header>
        <div className="creative-brief-page">
          <CreativeBriefForm job={job} onSubmitted={setJob} />
        </div>
      </main>
    );
  }

  const isBuildingDraft = Boolean(
    !job.timeline
    && ["received", "transcribing", "planning", "searching", "downloading", "rendering"].includes(job.status),
  );
  if (isBuildingDraft) {
    return <ProcessingScreen job={job} title="Montando o primeiro corte" message={job.message || "A IA está pesquisando e preparando a timeline."} />;
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
            {missingSourceCount > 0 && <p className="ai-warning">{missingSourceCount} trecho(s) de B-roll estão offline e aparecem marcados na timeline.</p>}
            <div className="ai-status-row"><span className="ai-live-dot" /><small>{statusLabels[job.status]}</small><b>{formatTime(project.duration)}</b></div>
            <div className="ai-card-progress"><span style={{ width: `${Math.min(100, job.progress)}%` }} /></div>
          </div>

          <div className="sidebar-section">
            <div className="sidebar-section-heading"><span>MEDIA</span><span className="tiny-count">{project.clips.filter((clip) => clip.trackId === "V1").length}</span></div>
            <div className="project-file"><span className="file-icon audio">◒</span><div><strong>{job.originalAudioName}</strong><small>Narração principal · {formatTime(project.duration)}</small></div></div>
            <input ref={narrationInputRef} className="sidebar-upload" type="file" accept="audio/*,.m4a,.mp3,.wav,.webm" onChange={createDraftFromEditor} />
            <button className="sidebar-action" onClick={() => narrationInputRef.current?.click()} disabled={creatingDraft}>＋ {creatingDraft ? "Enviando narração…" : "Nova narração"}</button>
            <button className="sidebar-action" onClick={() => setShowRecorder((value) => !value)} disabled={creatingDraft}>
              <span className={recorderState === "recording" ? "recording-icon active" : "recording-icon"}>●</span>
              {showRecorder ? "Fechar gravador" : "Gravar narração"}
            </button>
            {showRecorder && (
              <div className={`voice-recorder ${recorderState}`}>
                <div className="voice-recorder-head">
                  <div><span className="voice-recorder-dot" /><strong>{recorderState === "recording" ? "Gravando agora" : recorderState === "ready" ? "Gravação pronta" : "Gravar pelo microfone"}</strong></div>
                  <span className="voice-recorder-time">{formatTime(recordingSeconds)}</span>
                </div>
                {recorderState === "recording" ? (
                  <button className="voice-recorder-button stop" type="button" onClick={stopAudioRecording}>Parar gravação</button>
                ) : recorderState === "ready" && recordedAudioUrl ? (
                  <>
                    <audio className="voice-recorder-audio" controls src={recordedAudioUrl} />
                    <div className="voice-recorder-actions">
                      <button className="voice-recorder-button secondary" type="button" onClick={() => void startAudioRecording()}>Regravar</button>
                      <button className="voice-recorder-button use" type="button" onClick={useRecordedAudio} disabled={creatingDraft}>Usar gravação →</button>
                    </div>
                  </>
                ) : (
                  <button className="voice-recorder-button start" type="button" onClick={() => void startAudioRecording()}>Começar a gravar</button>
                )}
                <small>{recorderState === "recording" ? "Fale normalmente. O áudio será enviado somente quando você escolher usar a gravação." : "Use um microfone próximo e grave uma nova narração para este projeto."}</small>
              </div>
            )}
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
              {activeSourceVideoClips.length > 0 ? activeSourceVideoClips.map((clip) => (
                <video
                  key={clip.id}
                  ref={(element) => { if (element) videoRefs.current[clip.id] = element; else delete videoRefs.current[clip.id]; }}
                  className="preview-video"
                  src={jobId ? mediaUrl(jobId, clip.assetFileName) : ""}
                  muted
                  playsInline
                  preload="auto"
                />
              )) : activeMissingSourceClips.length > 0 ? <div className="preview-placeholder missing-source"><span>!</span><p>Fonte de vídeo indisponível neste trecho.</p><small>Revise as buscas ou substitua o B-roll no inspector.</small></div> : previewFallback ? <video className="preview-video preview-fallback" src={previewFallback} muted playsInline /> : <div className="preview-placeholder"><span>✦</span><p>Selecione um trecho para começar.</p></div>}
              <div className="preview-vignette" />
              <div className="preview-meta"><span>16:9</span><span>{activeSourceVideoClips[0]?.label || activeMissingSourceClips[0]?.label || "V1 · sem sinal"}</span></div>
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
                      const missingSource = track.id === "V1" && !clip.sourceUrl;
                      const clipStyle = { left: clip.start * zoom, width: Math.max(18, clip.duration * zoom) } as CSSProperties;
                      return <div className={`timeline-clip clip-${track.id.toLowerCase()} ${selected ? "selected" : ""} ${missingSource ? "missing-source" : ""}`} key={clip.id} style={clipStyle} onPointerDown={(event) => startGesture(event, clip, "move")} onClick={(event) => { event.stopPropagation(); setSelectedClipId(clip.id); }} title={missingSource ? `${clip.label} — fonte indisponível` : clip.label}>
                        {selected && track.id === "V1" && <button className="trim-handle left" onPointerDown={(event) => startGesture(event, clip, "left")} aria-label="Ajustar início" />}
                        <span className="clip-role">{track.kind === "audio" ? "VOICE" : missingSource ? "B-ROLL · OFFLINE" : "B-ROLL"}</span><span className="clip-wave">{track.kind === "audio" ? "▂▃▅▃▂▅▃▂" : ""}</span><strong>{clip.unitId || clip.label}</strong><small>{formatTime(clip.duration)}</small>
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
              {selectedClip.trackId === "V1" && !selectedClip.sourceUrl && <div className="source-warning"><strong>Fonte indisponível</strong><p>O download deste B-roll não foi concluído. O trecho está marcado como placeholder e não será tratado como vídeo real.</p></div>}
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
