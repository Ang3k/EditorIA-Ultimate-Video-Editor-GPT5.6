import type { EditorClip, EditorProject, EditorTrack, JobState } from "./types";

export const EDITOR_TRACKS: EditorTrack[] = [
  { id: "V2", kind: "video", name: "OVERLAYS", muted: false, locked: false },
  { id: "V1", kind: "video", name: "VÍDEO PRINCIPAL", muted: false, locked: false },
  { id: "A1", kind: "audio", name: "NARRAÇÃO", muted: false, locked: false },
];

function finite(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function cleanDuration(value: unknown, fallback: number) {
  return Math.max(0.1, finite(value, fallback));
}

function cloneTracks(rawTracks: unknown) {
  const source = Array.isArray(rawTracks) ? rawTracks : [];
  return EDITOR_TRACKS.map((defaultTrack) => {
    const raw = source.find((item) => {
      if (!item || typeof item !== "object") return false;
      return (item as { id?: unknown }).id === defaultTrack.id;
    });
    if (!raw || typeof raw !== "object") return { ...defaultTrack };
    const value = raw as Partial<EditorTrack>;
    return {
      ...defaultTrack,
      muted: Boolean(value.muted),
      locked: Boolean(value.locked),
    };
  });
}

function allowedAssetFileNames(job: JobState) {
  return new Set([
    job.audioFileName,
    ...(job.timeline || []).map((segment) => segment.fileName),
  ]);
}

export function createEditorProject(job: JobState): EditorProject {
  const duration = Math.max(
    0.1,
    finite(job.duration, (job.timeline || []).reduce((total, item) => total + item.duration, 0)),
  );
  const units = new Map((job.visualUnits || []).map((unit) => [unit.id, unit]));
  const videoClips: EditorClip[] = (job.timeline || []).flatMap((segment, index) => {
    const unit = units.get(segment.unitId);
    const start = clamp(finite(unit?.start, 0), 0, duration);
    const naturalDuration = unit ? Math.max(0.1, unit.end - unit.start) : segment.duration;
    const clipDuration = clamp(Math.min(segment.duration, naturalDuration), 0.1, Math.max(0.1, duration - start));
    if (start >= duration || clipDuration <= 0) return [];

    return [{
      id: `clip-${index}`,
      trackId: "V1",
      unitId: segment.unitId,
      assetType: "video",
      assetFileName: segment.fileName,
      label: unit?.visualBrief || segment.sourceTitle || `Trecho ${index + 1}`,
      start,
      duration: clipDuration,
      sourceStart: 0,
      sourceDuration: segment.duration,
      sourceUrl: segment.sourceUrl,
      sourceTitle: segment.sourceTitle,
    } satisfies EditorClip];
  });

  return {
    version: 1,
    title: job.editPlan?.title || "Rascunho EditorIA",
    width: 1920,
    height: 1080,
    fps: 30,
    duration,
    tracks: EDITOR_TRACKS.map((track) => ({ ...track })),
    clips: [
      ...videoClips,
      {
        id: "narration-1",
        trackId: "A1",
        assetType: "audio",
        assetFileName: job.audioFileName,
        label: job.originalAudioName || "Narração principal",
        start: 0,
        duration,
        sourceStart: 0,
        sourceDuration: duration,
      },
    ],
  };
}

export function normalizeEditorProject(raw: unknown, job: JobState): EditorProject {
  const fallback = createEditorProject(job);
  if (!raw || typeof raw !== "object") return fallback;

  const value = raw as Partial<EditorProject>;
  const duration = clamp(finite(value.duration, fallback.duration), 0.1, 24 * 60 * 60);
  const allowedFiles = allowedAssetFileNames(job);
  const rawClips = Array.isArray(value.clips) ? value.clips : fallback.clips;
  const clips = rawClips.flatMap((rawClip, index) => {
    if (!rawClip || typeof rawClip !== "object") return [];
    const clip = rawClip as Partial<EditorClip>;
    const trackId = clip.trackId === "V2" || clip.trackId === "V1" || clip.trackId === "A1" ? clip.trackId : "V1";
    const fallbackClip = fallback.clips[index];
    const assetFileName = typeof clip.assetFileName === "string" && allowedFiles.has(clip.assetFileName)
      ? clip.assetFileName
      : fallbackClip?.assetFileName;
    const start = clamp(finite(clip.start, fallbackClip?.start || 0), 0, duration);
    const maxDuration = Math.max(0.1, duration - start);
    const clipDuration = clamp(cleanDuration(clip.duration, fallbackClip?.duration || maxDuration), 0.1, maxDuration);
    if (!assetFileName || start >= duration) return [];

    return [{
      id: typeof clip.id === "string" && clip.id ? clip.id : `clip-${index}`,
      trackId,
      unitId: typeof clip.unitId === "string" ? clip.unitId : fallbackClip?.unitId,
      assetType: trackId === "A1" ? "audio" : "video",
      assetFileName,
      label: typeof clip.label === "string" && clip.label ? clip.label : fallbackClip?.label || "Mídia",
      start,
      duration: clipDuration,
      sourceStart: Math.max(0, finite(clip.sourceStart, fallbackClip?.sourceStart || 0)),
      sourceDuration: Math.max(clipDuration, finite(clip.sourceDuration, fallbackClip?.sourceDuration || clipDuration)),
      sourceUrl: typeof clip.sourceUrl === "string" ? clip.sourceUrl : fallbackClip?.sourceUrl,
      sourceTitle: typeof clip.sourceTitle === "string" ? clip.sourceTitle : fallbackClip?.sourceTitle,
    } satisfies EditorClip];
  });

  return {
    version: 1,
    title: typeof value.title === "string" && value.title ? value.title : fallback.title,
    width: 1920,
    height: 1080,
    fps: 30,
    duration,
    tracks: cloneTracks(value.tracks),
    clips,
  };
}
