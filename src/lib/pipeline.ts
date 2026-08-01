import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createPlaceholder, getMediaDuration, normalizeVideo, prepareAudioForTranscription, renderEditorProject, renderTimeline } from "./ffmpeg";
import {
  getJobDirectory,
  getJobFile,
  readJob,
  saveArtifact,
  updateJob,
} from "./job-store";
import { chooseClips, createCreativeQuestions, createVisualPlan, transcribeAudio } from "./gemini-editor";
import { creativeBriefToPrompt } from "./creative-brief";
import { downloadClip, locateCaptionStart, searchCandidates } from "./youtube";
import { createEditorProject } from "./editor-project";
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
    if (!job.transcript) {
      await setProgress(jobId, 5, "Transcrevendo a narração…", "transcribing");
      const transcriptionPath = path.join(jobDirectory, "audio-for-transcription.mp3");
      const audioForTranscription = await prepareAudioForTranscription(audioPath, transcriptionPath);
      const detectedDuration = await getMediaDuration(audioPath);
      const transcript = await transcribeAudio(audioForTranscription);
      const duration = Math.max(detectedDuration, transcript.duration || 0);
      transcript.duration = duration;
      const questions = await createCreativeQuestions(transcript, job.brief, duration);
      const creativeBrief = { questions, answers: {} };
      await saveArtifact(jobId, "transcript.json", transcript);
      await saveArtifact(jobId, "creative-questions.json", questions);
      await saveArtifact(jobId, "creative-brief.json", creativeBrief);
      await updateJob(jobId, {
        transcript,
        duration,
        creativeBrief,
        status: "awaiting_direction",
        progress: 18,
        message: "A narração está pronta. Defina a direção criativa antes da busca.",
      });
      return;
    }

    if (!job.creativeBrief?.submittedAt) {
      throw new Error("A direção criativa ainda não foi respondida.");
    }

    const transcript = job.transcript;
    const duration = Math.max(job.duration || 0, transcript.duration || 0);
    const creativeDirection = creativeBriefToPrompt(job.brief, job.creativeBrief);

    await setProgress(jobId, 22, "Entendendo o que deve aparecer em cada trecho…", "planning");
    const plannedUnits = await createVisualPlan(transcript, creativeDirection, duration);
    const visualUnits = ensureVisualCoverage(plannedUnits, duration);
    await saveArtifact(jobId, "visual-units.json", visualUnits);
    await updateJob(jobId, { visualUnits });

    await setProgress(jobId, 38, "Pesquisando vídeos contextualizados no YouTube…", "searching");
    const candidates = await searchCandidates(visualUnits);
    await saveArtifact(jobId, "search-results.json", candidates);
    await updateJob(jobId, { candidates });

    await setProgress(jobId, 52, "Escolhendo os candidatos e montando o plano de edição…", "planning");
    const draftPlan = await chooseClips(visualUnits, candidates, duration, creativeDirection);
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
          .then(async () => getMediaDuration(rawPath).then((sourceDuration) => sourceDuration > 0.25).catch(() => false))
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
        sourceUrl: hasSource ? candidate?.url : undefined,
        sourceTitle: hasSource ? candidate?.title : undefined,
      });
      await setProgress(
        jobId,
        60 + Math.round(((index + 1) / editPlan.clips.length) * 22),
        `Trecho ${index + 1} de ${editPlan.clips.length} preparado.`,
        "downloading",
      );
    }

    await saveArtifact(jobId, "timeline.json", timeline);
    const editorProject = createEditorProject({ ...job, duration, visualUnits, editPlan, timeline });
    await saveArtifact(jobId, "editor-project.json", editorProject);
    const unavailableSources = timeline.filter((segment) => !segment.sourceUrl).length;
    await updateJob(jobId, {
      timeline,
      editorProject,
      ...(unavailableSources > 0 ? { message: `Preview pronto com ${unavailableSources} trecho(s) sem fonte local; revise as buscas.` } : {}),
    });

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
      message: unavailableSources > 0
        ? `Preview pronto para revisão; ${unavailableSources} trecho(s) ficaram sem fonte local.`
        : "Preview pronto para revisão.",
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

export function startCreativeBriefPipeline(jobId: string) {
  return startJobPipeline(jobId);
}

async function runFinalRender(jobId: string) {
  const job = await readJob(jobId);
  if ((!job.timeline || job.timeline.length === 0) && !job.editorProject) {
    throw new Error("O job ainda não possui uma timeline renderizável.");
  }

  await updateJob(jobId, { status: "exporting", progress: 10, message: "Exportando a versão final…" });
  if (job.editorProject) {
    await renderEditorProject({
      jobDirectory: getJobDirectory(jobId),
      project: job.editorProject,
      narrationPath: getJobFile(jobId, job.audioFileName),
      outputPath: getJobFile(jobId, "final.mp4"),
      quality: "final",
    });
  } else {
    await renderTimeline({
      jobDirectory: getJobDirectory(jobId),
      segments: job.timeline || [],
      narrationPath: getJobFile(jobId, job.audioFileName),
      outputPath: getJobFile(jobId, "final.mp4"),
      quality: "final",
    });
  }
  await updateJob(jobId, {
    status: "completed",
    progress: 100,
    message: "Exportação final concluída.",
    media: { ...job.media, final: "final.mp4" },
  });
}

async function runEditorPreviewRender(jobId: string) {
  const job = await readJob(jobId);
  if (!job.editorProject) {
    throw new Error("O projeto do editor ainda não foi criado.");
  }

  await updateJob(jobId, { status: "rendering", progress: 90, message: "Atualizando o preview da timeline…" });
  await renderEditorProject({
    jobDirectory: getJobDirectory(jobId),
    project: job.editorProject,
    narrationPath: getJobFile(jobId, job.audioFileName),
    outputPath: getJobFile(jobId, "preview.mp4"),
    quality: "preview",
  });
  await updateJob(jobId, {
    status: "awaiting_approval",
    progress: 100,
    message: "Preview atualizado para revisão.",
    media: { ...job.media, preview: "preview.mp4" },
  });
}

export function startEditorPreviewRender(jobId: string) {
  const existing = activeJobs.get(jobId);
  if (existing) return existing;

  const promise = runEditorPreviewRender(jobId).catch(async (error) => {
    await updateJob(jobId, {
      status: "failed",
      progress: 100,
      message: "A atualização do preview falhou.",
      error: error instanceof Error ? error.message : "Falha desconhecida ao atualizar o preview.",
    });
  }).finally(() => {
    activeJobs.delete(jobId);
  });
  activeJobs.set(jobId, promise);
  return promise;
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
