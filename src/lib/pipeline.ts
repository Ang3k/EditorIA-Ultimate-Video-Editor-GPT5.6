import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createPlaceholder, getMediaDuration, normalizeVideo, prepareAudioForTranscription, renderTimeline } from "./ffmpeg";
import {
  getJobDirectory,
  getJobFile,
  readJob,
  saveArtifact,
  updateJob,
} from "./job-store";
import { chooseClips, createVisualPlan, transcribeAudio } from "./openai-editor";
import { downloadClip, locateCaptionStart, searchCandidates } from "./youtube";
import type { EditPlan, JobState, TimelineSegment, VisualUnit, YouTubeCandidate } from "./types";

const activeJobs = new Map<string, Promise<void>>();

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function makeGapUnit(index: number, start: number, end: number): VisualUnit {
  return {
    id: `gap-${index}`,
    start,
    end,
    narration: "",
    visualBrief: "B-roll de apoio neutro para cobrir a transição da narração.",
    queries: [],
    mustShow: [],
    confidence: 0.2,
  };
}

function ensureVisualCoverage(units: VisualUnit[], duration: number) {
  const sorted = [...units]
    .map((unit) => ({
      ...unit,
      start: clamp(unit.start, 0, duration),
      end: clamp(Math.max(unit.end, unit.start + 0.5), 0, duration),
    }))
    .filter((unit) => unit.end > unit.start)
    .sort((left, right) => left.start - right.start);

  const covered: VisualUnit[] = [];
  let cursor = 0;
  let gapIndex = 0;
  for (const unit of sorted) {
    if (unit.start > cursor + 0.15) {
      covered.push(makeGapUnit(gapIndex, cursor, unit.start));
      gapIndex += 1;
    }
    const start = Math.max(cursor, unit.start);
    const end = Math.max(start + 0.5, unit.end);
    covered.push({ ...unit, start, end: Math.min(end, duration) });
    cursor = Math.max(cursor, end);
  }

  if (cursor < duration - 0.15) {
    covered.push(makeGapUnit(gapIndex, cursor, duration));
  }

  return covered.filter((unit) => unit.end > unit.start);
}

function normalizeEditPlan(
  rawPlan: EditPlan,
  units: VisualUnit[],
  candidates: YouTubeCandidate[],
): EditPlan {
  const rawByUnit = new Map(rawPlan.clips.map((clip) => [clip.unitId, clip]));
  const normalizedClips = units.map((unit) => {
    const raw = rawByUnit.get(unit.id);
    const candidate = raw?.candidateId ? candidates.find((item) => item.id === raw.candidateId) : undefined;
    const duration = clamp(unit.end - unit.start, 1, 30);
    return {
      unitId: unit.id,
      candidateId: candidate?.id || null,
      sourceStart: candidate ? Math.max(0, raw?.sourceStart || 0) : 0,
      duration,
      confidence: candidate ? clamp(raw?.confidence || 0, 0, 1) : 0.15,
      rationale: raw?.rationale || "Nenhum candidato confiável foi encontrado; usando placeholder.",
    };
  });

  return {
    title: rawPlan.title || "Rascunho EditorIA",
    visualStyle: rawPlan.visualStyle || "B-roll contextual, sem áudio original dos vídeos.",
    clips: normalizedClips,
  };
}

async function setProgress(jobId: string, progress: number, message: string, status?: JobState["status"]) {
  await updateJob(jobId, { progress, message, ...(status ? { status } : {}) });
}

async function runPipeline(jobId: string) {
  const job = await readJob(jobId);
  const jobDirectory = getJobDirectory(jobId);
  const audioPath = getJobFile(jobId, job.audioFileName);

  try {
    await setProgress(jobId, 5, "Transcrevendo a narração…", "transcribing");
    const transcriptionPath = path.join(jobDirectory, "audio-for-transcription.mp3");
    const audioForTranscription = await prepareAudioForTranscription(audioPath, transcriptionPath);
    const detectedDuration = await getMediaDuration(audioPath);
    const transcript = await transcribeAudio(audioForTranscription);
    const duration = Math.max(detectedDuration, transcript.duration || 0);
    transcript.duration = duration;
    await saveArtifact(jobId, "transcript.json", transcript);
    await updateJob(jobId, { transcript, duration });

    await setProgress(jobId, 22, "Entendendo o que deve aparecer em cada trecho…", "planning");
    const plannedUnits = await createVisualPlan(transcript, job.brief, duration);
    const visualUnits = ensureVisualCoverage(plannedUnits, duration);
    await saveArtifact(jobId, "visual-units.json", visualUnits);
    await updateJob(jobId, { visualUnits });

    await setProgress(jobId, 38, "Pesquisando vídeos contextualizados no YouTube…", "searching");
    const candidates = await searchCandidates(visualUnits);
    await saveArtifact(jobId, "search-results.json", candidates);
    await updateJob(jobId, { candidates });

    await setProgress(jobId, 52, "Escolhendo os candidatos e montando o plano de edição…", "planning");
    const draftPlan = await chooseClips(visualUnits, candidates, duration);
    const editPlan = normalizeEditPlan(draftPlan, visualUnits, candidates);
    await saveArtifact(jobId, "edit-plan.json", editPlan);
    await updateJob(jobId, { editPlan });

    await setProgress(jobId, 60, "Baixando e preparando os trechos selecionados…", "downloading");
    const segmentsDirectory = path.join(jobDirectory, "segments");
    const captionsDirectory = path.join(jobDirectory, "captions");
    await mkdir(segmentsDirectory, { recursive: true });
    await mkdir(captionsDirectory, { recursive: true });

    const timeline: TimelineSegment[] = [];
    for (let index = 0; index < editPlan.clips.length; index += 1) {
      const planned = editPlan.clips[index];
      const unit = visualUnits.find((item) => item.id === planned.unitId);
      const candidate = planned.candidateId ? candidates.find((item) => item.id === planned.candidateId) : undefined;
      const durationForClip = clamp(planned.duration, 1, 30);
      const rawPath = path.join(segmentsDirectory, `raw-${index}.mp4`);
      const normalizedPath = path.join(segmentsDirectory, `segment-${index}.mp4`);
      let hasSource = false;
      let sourceStart = planned.sourceStart;

      if (candidate) {
        const captionStart = await locateCaptionStart({
          url: candidate.url,
          directory: path.join(captionsDirectory, String(index)),
          terms: [...(unit?.mustShow || []), ...(unit?.queries || [])],
        }).catch(() => null);
        if (captionStart !== null) {
          sourceStart = captionStart;
        }

        hasSource = await downloadClip({
          url: candidate.url,
          outputPath: rawPath,
          start: sourceStart,
          duration: durationForClip,
        })
          .then(() => true)
          .catch(() => false);
      }

      if (hasSource) {
        await normalizeVideo(rawPath, normalizedPath, durationForClip).catch(async () => {
          hasSource = false;
          await createPlaceholder(normalizedPath, durationForClip);
        });
      } else {
        await createPlaceholder(normalizedPath, durationForClip);
      }

      timeline.push({
        unitId: planned.unitId,
        fileName: `segments/segment-${index}.mp4`,
        duration: durationForClip,
        sourceUrl: candidate?.url,
        sourceTitle: candidate?.title,
      });
      await setProgress(
        jobId,
        60 + Math.round(((index + 1) / editPlan.clips.length) * 22),
        `Trecho ${index + 1} de ${editPlan.clips.length} preparado.`,
        "downloading",
      );
    }

    await saveArtifact(jobId, "timeline.json", timeline);
    await updateJob(jobId, { timeline });

    await setProgress(jobId, 86, "Renderizando o preview…", "rendering");
    await renderTimeline({
      jobDirectory,
      segments: timeline,
      narrationPath: audioPath,
      outputPath: getJobFile(jobId, "preview.mp4"),
      quality: "preview",
    });
    await updateJob(jobId, {
      status: "awaiting_approval",
      progress: 100,
      message: "Preview pronto para revisão.",
      media: { preview: "preview.mp4" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha desconhecida no pipeline.";
    await updateJob(jobId, {
      status: "failed",
      progress: 100,
      message: "O job falhou.",
      error: message,
    });
  }
}

export function startJobPipeline(jobId: string) {
  const existing = activeJobs.get(jobId);
  if (existing) return existing;

  const promise = runPipeline(jobId).finally(() => {
    activeJobs.delete(jobId);
  });
  activeJobs.set(jobId, promise);
  return promise;
}

async function runFinalRender(jobId: string) {
  const job = await readJob(jobId);
  if (!job.timeline || job.timeline.length === 0) {
    throw new Error("O job ainda não possui uma timeline renderizável.");
  }

  await updateJob(jobId, { status: "exporting", progress: 10, message: "Exportando a versão final…" });
  await renderTimeline({
    jobDirectory: getJobDirectory(jobId),
    segments: job.timeline,
    narrationPath: getJobFile(jobId, job.audioFileName),
    outputPath: getJobFile(jobId, "final.mp4"),
    quality: "final",
  });
  await updateJob(jobId, {
    status: "completed",
    progress: 100,
    message: "Exportação final concluída.",
    media: { ...job.media, final: "final.mp4" },
  });
}

export function startFinalRender(jobId: string) {
  const existing = activeJobs.get(jobId);
  if (existing) return existing;

  const promise = runFinalRender(jobId).catch(async (error) => {
    await updateJob(jobId, {
      status: "failed",
      progress: 100,
      message: "A exportação final falhou.",
      error: error instanceof Error ? error.message : "Falha desconhecida na exportação.",
    });
  }).finally(() => {
    activeJobs.delete(jobId);
  });
  activeJobs.set(jobId, promise);
  return promise;
}
