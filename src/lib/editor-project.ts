import type { EditorClip, EditorProject, EditorTrack, JobState } from "./types";

export const EDITOR_TRACKS: EditorTrack[] = [
  { id: "V2", kind: "video", name: "CONTEXTUAL OVERLAYS", muted: false, locked: false },
  { id: "V1", kind: "video", name: "BASE COVERAGE", muted: false, locked: true },
  { id: "A1", kind: "audio", name: "VOICEOVER", muted: false, locked: false },
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
    const raw = source.find((item) => item && typeof item === "object" && (item as { id?: unknown }).id === defaultTrack.id);
    if (!raw || typeof raw !== "object") return { ...defaultTrack };
    const value = raw as Partial<EditorTrack>;
    return {
      ...defaultTrack,
      muted: Boolean(value.muted),
      locked: defaultTrack.id === "V1" ? true : Boolean(value.locked),
    };
  });
}

function allowedAssetFileNames(job: JobState) {
  return new Set([
    job.audioFileName,
    job.baseCoverage?.fileName,
    ...(job.timeline || []).map((segment) => segment.fileName),
  ].filter((value): value is string => Boolean(value)));
}

function createBaseClip(job: JobState, duration: number): EditorClip {
  if (!job.baseCoverage) throw new Error("O projeto ainda não possui uma gameplay-base real.");
  return {
    id: "base-coverage-1",
    trackId: "V1",
    role: "base",
    unitId: "base",
    assetType: "video",
    assetFileName: job.baseCoverage.fileName,
    label: "Gameplay-base contínua",
    start: 0,
    duration,
    sourceStart: job.baseCoverage.sourceStart || 0,
    sourceDuration: duration,
    sourceUrl: job.baseCoverage.sourceUrl,
    sourceTitle: job.baseCoverage.sourceTitle,
    coverage: "source",
  };
}

export function createEditorProject(job: JobState): EditorProject {
  const duration = Math.max(
    0.1,
    finite(job.duration, (job.timeline || []).reduce((total, item) => total + item.duration, 0)),
  );
  const units = new Map((job.visualUnits || []).map((unit) => [unit.id, unit]));
  const baseClip = createBaseClip(job, duration);
  const contextualClips: EditorClip[] = (job.timeline || []).flatMap((segment, index) => {
    const unit = units.get(segment.unitId);
    const start = clamp(finite(unit?.start, 0), 0, duration);
    const naturalDuration = unit ? Math.max(0.1, unit.end - unit.start) : segment.duration;
    const clipDuration = clamp(Math.min(segment.duration, naturalDuration), 0.1, Math.max(0.1, duration - start));
    if (start >= duration || clipDuration <= 0) return [];

    return [{
      id: `contextual-${index}`,
      trackId: "V2",
      role: "contextual",
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
      coverage: "source",
    } satisfies EditorClip];
  });

  return {
    version: 2,
    title: job.editPlan?.title || "Rascunho EditorIA",
    width: 1920,
    height: 1080,
    fps: 30,
    duration,
    tracks: EDITOR_TRACKS.map((track) => ({ ...track })),
    clips: [
      ...contextualClips,
      baseClip,
      {
        id: "narration-1",
        trackId: "A1",
        role: "audio",
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

export function assertBaseCoverage(project: EditorProject) {
  const base = project.clips.find((clip) => clip.role === "base" || (clip.trackId === "V1" && clip.unitId === "base"));
  if (!base || base.start > 0.05 || base.duration < project.duration - 0.05) {
    throw new Error("A timeline precisa de uma gameplay-base real cobrindo toda a narração.");
  }
  return base;
}

export function normalizeEditorProject(raw: unknown, job: JobState): EditorProject {
  const fallback = createEditorProject(job);
  if (!raw || typeof raw !== "object") return fallback;

  const value = raw as Partial<EditorProject>;
  const duration = clamp(finite(value.duration, fallback.duration), 0.1, 24 * 60 * 60);
  const allowedFiles = allowedAssetFileNames(job);
  const fallbackBase = fallback.clips.find((clip) => clip.role === "base") as EditorClip;
  const fallbackAudio = fallback.clips.find((clip) => clip.trackId === "A1") as EditorClip;
  const fallbackContextual = fallback.clips.filter((clip) => clip.role === "contextual");
  const rawClips = Array.isArray(value.clips) ? value.clips : [];
  const clips: EditorClip[] = [];

  for (const rawClip of rawClips) {
    if (!rawClip || typeof rawClip !== "object") continue;
    const clip = rawClip as Partial<EditorClip>;
    const rawRole = clip.role;
    const isAudio = clip.trackId === "A1" || rawRole === "audio";
    const isBase = !isAudio && (rawRole === "base" || clip.unitId === "base" || clip.id === fallbackBase.id);
    const fallbackClip = isAudio ? fallbackAudio : isBase
      ? fallbackBase
      : fallbackContextual.find((item) => item.id === clip.id || item.unitId === clip.unitId);
    const assetFileName = typeof clip.assetFileName === "string" && allowedFiles.has(clip.assetFileName)
      ? clip.assetFileName
      : fallbackClip?.assetFileName;
    if (!assetFileName) continue;

    if (isBase) {
      clips.push({ ...fallbackBase, duration, sourceDuration: duration });
      continue;
    }
    if (isAudio) {
      clips.push({ ...fallbackAudio, duration, sourceDuration: duration, label: typeof clip.label === "string" && clip.label ? clip.label : fallbackAudio.label });
      continue;
    }

    const start = clamp(finite(clip.start, fallbackClip?.start || 0), 0, duration);
    const maxDuration = Math.max(0.1, duration - start);
    const clipDuration = clamp(cleanDuration(clip.duration, fallbackClip?.duration || maxDuration), 0.1, maxDuration);
    if (start >= duration) continue;
    clips.push({
      id: typeof clip.id === "string" && clip.id ? clip.id : `contextual-${clips.length}`,
      trackId: "V2",
      role: "contextual",
      unitId: typeof clip.unitId === "string" ? clip.unitId : fallbackClip?.unitId,
      assetType: "video",
      assetFileName,
      label: typeof clip.label === "string" && clip.label ? clip.label : fallbackClip?.label || "B-roll contextual",
      start,
      duration: clipDuration,
      sourceStart: Math.max(0, finite(clip.sourceStart, fallbackClip?.sourceStart || 0)),
      sourceDuration: Math.max(clipDuration, finite(clip.sourceDuration, fallbackClip?.sourceDuration || clipDuration)),
      sourceUrl: typeof clip.sourceUrl === "string" ? clip.sourceUrl : fallbackClip?.sourceUrl,
      sourceTitle: typeof clip.sourceTitle === "string" ? clip.sourceTitle : fallbackClip?.sourceTitle,
      coverage: "source",
    });
  }

  if (!clips.some((clip) => clip.role === "base")) clips.push({ ...fallbackBase, duration, sourceDuration: duration });
  if (!clips.some((clip) => clip.trackId === "A1")) clips.push({ ...fallbackAudio, duration, sourceDuration: duration });

  return {
    version: 2,
    title: typeof value.title === "string" && value.title ? value.title : fallback.title,
    width: 1920,
    height: 1080,
    fps: 30,
    duration,
    tracks: cloneTracks(value.tracks),
    clips,
  };
}
