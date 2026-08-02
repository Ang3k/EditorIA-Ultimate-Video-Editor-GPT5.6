import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  extractContactSheet,
  getMediaDuration,
  hasExtendedBlackFrame,
  normalizeVideo,
  prepareAudioForTranscription,
  renderEditorProject,
} from "./ffmpeg";
import {
  getJobDirectory,
  getJobFile,
  readJob,
  saveArtifact,
  updateJob,
} from "./job-store";
import {
  chooseClips,
  createCreativeQuestions,
  createVisualPlan,
  normalizeTranscript,
  transcribeAudio,
  verifyCandidate,
} from "./ai-editor";
import { creativeBriefToPrompt } from "./creative-brief";
import { downloadClip, locateCaptionStart, searchCandidates } from "./youtube";
import { assertBaseCoverage, createEditorProject } from "./editor-project";
import type {
  BaseCoverage,
  CandidateVerification,
  EditPlan,
  JobState,
  TimelineSegment,
  VisualPlan,
  VisualUnit,
  YouTubeCandidate,
} from "./types";

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
    visualBrief: "Continuidade coberta pela gameplay-base.",
    subject: "",
    action: "",
    location: "",
    queries: [],
    mustShow: [],
    mustAvoid: [],
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
    const end = Math.min(duration, Math.max(start + 0.5, unit.end));
    if (end > start) covered.push({ ...unit, start, end });
    cursor = Math.max(cursor, end);
  }
  if (cursor < duration - 0.15) covered.push(makeGapUnit(gapIndex, cursor, duration));
  return covered.filter((unit) => unit.end > unit.start);
}

function normalizeEditPlan(
  rawPlan: EditPlan,
  units: VisualUnit[],
  candidates: YouTubeCandidate[],
  baseCandidates: YouTubeCandidate[],
): EditPlan {
  const rawByUnit = new Map(rawPlan.clips.map((clip) => [clip.unitId, clip]));
  const normalizedClips = units.map((unit) => {
    const raw = rawByUnit.get(unit.id);
    const candidateIds = (raw?.candidateIds || []).filter((id) => candidates.some((candidate) => candidate.id === id && candidate.unitId === unit.id)).slice(0, 5);
    const duration = clamp(unit.end - unit.start, 1, 30);
    return {
      unitId: unit.id,
      candidateId: null,
      candidateIds,
      sourceStart: Math.max(0, raw?.sourceStart || 0),
      duration,
      confidence: clamp(raw?.confidence || 0, 0, 1),
      rationale: raw?.rationale || "Nenhum overlay específico foi aprovado; a gameplay-base continuará visível.",
    };
  });
  const baseCandidateIds = (rawPlan.baseCandidateIds || [])
    .filter((id) => baseCandidates.some((candidate) => candidate.id === id))
    .slice(0, 8);

  return {
    title: rawPlan.title || "Rascunho EditorIA",
    visualStyle: rawPlan.visualStyle || "Gameplay-base contínua com overlays contextuais aprovados.",
    baseQuery: rawPlan.baseQuery || "gameplay no commentary",
    baseCandidateIds,
    clips: normalizedClips,
  };
}

async function setProgress(jobId: string, progress: number, message: string, status?: JobState["status"]) {
  await updateJob(jobId, { progress, message, ...(status ? { status } : {}) });
}

function uniqueCandidates(candidates: YouTubeCandidate[]) {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.unitId}:${candidate.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function orderedCandidates(ids: string[], candidates: YouTubeCandidate[], limit: number) {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const selected: YouTubeCandidate[] = [];
  for (const id of ids) {
    const candidate = byId.get(id);
    if (candidate && !selected.some((item) => item.id === candidate.id)) selected.push(candidate);
  }
  for (const candidate of candidates) {
    if (!selected.some((item) => item.id === candidate.id)) selected.push(candidate);
    if (selected.length >= limit) break;
  }
  return selected.slice(0, limit);
}

async function verifyDownloadedCandidate(input: {
  jobDirectory: string;
  candidate: YouTubeCandidate;
  unit?: VisualUnit;
  baseMustShow?: string[];
  inputPath: string;
  duration: number;
  verificationDirectory: string;
}): Promise<CandidateVerification> {
  const blackFrameRisk = await hasExtendedBlackFrame(input.inputPath).catch(() => true);
  const contactSheet = path.join(input.verificationDirectory, `${input.candidate.unitId}-${input.candidate.id}.jpg`);
  await extractContactSheet(input.inputPath, contactSheet, input.duration);
  const verification = await verifyCandidate({
    candidate: input.candidate,
    unit: input.unit,
    baseMustShow: input.baseMustShow,
    imagePaths: [contactSheet],
    jobDirectory: input.jobDirectory,
  });
  return {
    ...verification,
    blackFrameRisk: verification.blackFrameRisk || blackFrameRisk,
    status: verification.status === "approved" && !blackFrameRisk ? "approved" : "rejected",
    rejectionReason: blackFrameRisk
      ? "O trecho contém uma sequência preta longa demais."
      : verification.rejectionReason,
  };
}

function addVerification(
  allCandidates: YouTubeCandidate[],
  candidate: YouTubeCandidate,
  verification: CandidateVerification,
) {
  const stored = allCandidates.find((item) => item.id === candidate.id && item.unitId === candidate.unitId);
  if (stored) stored.verification = verification;
}

async function findBaseCoverage(input: {
  jobId: string;
  jobDirectory: string;
  duration: number;
  editPlan: EditPlan;
  baseCandidates: YouTubeCandidate[];
  baseMustShow: string[];
  allCandidates: YouTubeCandidate[];
  verificationDirectory: string;
}): Promise<BaseCoverage> {
  const selectedCandidates = orderedCandidates(input.editPlan.baseCandidateIds, input.baseCandidates, 6);
  const baseDirectory = path.join(input.jobDirectory, "base");
  await mkdir(baseDirectory, { recursive: true });
  const probeDuration = Math.min(Math.max(20, input.duration), 60);

  for (let index = 0; index < selectedCandidates.length; index += 1) {
    const candidate = selectedCandidates[index];
    await setProgress(input.jobId, 48 + Math.round((index / Math.max(1, selectedCandidates.length)) * 8), `Validando gameplay-base ${index + 1} de ${selectedCandidates.length}…`, "verifying");
    const probePath = path.join(input.verificationDirectory, `base-probe-${index}.mp4`);
    try {
      const probeStart = Math.min(90, Math.max(0, (candidate.duration || input.duration + 90) - probeDuration - 1));
      await downloadClip({ url: candidate.url, outputPath: probePath, start: probeStart, duration: probeDuration });
      const probeSourceDuration = await getMediaDuration(probePath);
      if (probeSourceDuration <= 0.25) throw new Error("O download não contém vídeo utilizável.");
      const verification = await verifyDownloadedCandidate({
        jobDirectory: input.jobDirectory,
        candidate,
        baseMustShow: input.baseMustShow,
        inputPath: probePath,
        duration: Math.min(probeSourceDuration, probeDuration),
        verificationDirectory: input.verificationDirectory,
      });
      addVerification(input.allCandidates, candidate, verification);
      if (verification.status !== "approved") continue;

      const rawBasePath = path.join(baseDirectory, "raw-base.mp4");
      const normalizedBasePath = path.join(baseDirectory, "base.mp4");
      await downloadClip({ url: candidate.url, outputPath: rawBasePath, start: probeStart, duration: input.duration });
      await normalizeVideo(rawBasePath, normalizedBasePath, input.duration);
      const normalizedDuration = await getMediaDuration(normalizedBasePath);
      if (normalizedDuration < input.duration - 0.15) throw new Error("A gameplay-base não cobre toda a narração.");
      if (await hasExtendedBlackFrame(normalizedBasePath)) throw new Error("A gameplay-base contém uma tela preta longa.");

      const coverage: BaseCoverage = {
        fileName: "base/base.mp4",
        duration: input.duration,
        sourceStart: probeStart,
        candidateId: candidate.id,
        sourceUrl: candidate.url,
        sourceTitle: candidate.title,
        coverage: "source",
      };
      await saveArtifact(input.jobId, "base-coverage.json", coverage);
      return coverage;
    } catch (error) {
      addVerification(input.allCandidates, candidate, {
        status: "rejected",
        directMatchScore: 0,
        rawFootage: false,
        editedCreatorRisk: false,
        blackFrameRisk: false,
        sourceKind: candidate.sourceKind || "unknown",
        evidence: [],
        rejectionReason: error instanceof Error ? error.message : "Falha ao validar a gameplay-base.",
        checkedAt: new Date().toISOString(),
      });
    }
  }

  throw new Error("Não foi possível baixar e validar uma gameplay-base real. O preview não foi criado para evitar tela preta.");
}

async function findContextualSegments(input: {
  jobId: string;
  jobDirectory: string;
  duration: number;
  units: VisualUnit[];
  editPlan: EditPlan;
  candidates: YouTubeCandidate[];
  allCandidates: YouTubeCandidate[];
  captionsDirectory: string;
  verificationDirectory: string;
}) {
  const segmentsDirectory = path.join(input.jobDirectory, "segments");
  await mkdir(segmentsDirectory, { recursive: true });
  const timeline: TimelineSegment[] = [];
  const overlayPlans = input.editPlan.clips.filter((clip) => !clip.unitId.startsWith("gap-") && clip.candidateIds.length > 0);

  for (let index = 0; index < overlayPlans.length; index += 1) {
    const planned = overlayPlans[index];
    const unit = input.units.find((item) => item.id === planned.unitId);
    if (!unit) continue;
    // An empty candidateIds is an intentional decision from Luna: keep the
    // base visible instead of silently substituting a generic/random clip.
    const candidates = planned.candidateIds.length > 0
      ? orderedCandidates(
          planned.candidateIds,
          input.candidates.filter((candidate) => candidate.unitId === planned.unitId),
          3,
        )
      : [];
    const durationForClip = clamp(planned.duration, 1, 30);
    let accepted: { candidate: YouTubeCandidate; normalizedPath: string } | null = null;

    for (let attempt = 0; attempt < candidates.length; attempt += 1) {
      const candidate = candidates[attempt];
      await setProgress(input.jobId, 58 + Math.round(((index + attempt / Math.max(1, candidates.length)) / Math.max(1, overlayPlans.length)) * 22), `Validando overlay ${index + 1} de ${overlayPlans.length}…`, "verifying");
      const rawPath = path.join(segmentsDirectory, `raw-${index}-${attempt}.mp4`);
      const normalizedPath = path.join(segmentsDirectory, `segment-${index}.mp4`);
      try {
        const captionStart = attempt === 0
          ? await locateCaptionStart({
              url: candidate.url,
              directory: path.join(input.captionsDirectory, String(index), candidate.id),
              terms: [...unit.mustShow, ...unit.queries],
            }).catch(() => null)
          : null;
        const sourceStart = captionStart !== null ? captionStart : planned.sourceStart;
        await downloadClip({ url: candidate.url, outputPath: rawPath, start: sourceStart, duration: durationForClip });
        const sourceDuration = await getMediaDuration(rawPath);
        if (sourceDuration <= 0.25) throw new Error("O download não contém vídeo utilizável.");
        await normalizeVideo(rawPath, normalizedPath, durationForClip);
        const verification = await verifyDownloadedCandidate({
          jobDirectory: input.jobDirectory,
          candidate,
          unit,
          inputPath: normalizedPath,
          duration: durationForClip,
          verificationDirectory: input.verificationDirectory,
        });
        addVerification(input.allCandidates, candidate, verification);
        if (verification.status !== "approved") continue;
        accepted = { candidate, normalizedPath };
        planned.candidateId = candidate.id;
        planned.sourceStart = sourceStart;
        break;
      } catch (error) {
        addVerification(input.allCandidates, candidate, {
          status: "rejected",
          directMatchScore: 0,
          rawFootage: false,
          editedCreatorRisk: false,
          blackFrameRisk: false,
          sourceKind: candidate.sourceKind || "unknown",
          evidence: [],
          rejectionReason: error instanceof Error ? error.message : "Falha ao baixar ou validar o overlay.",
          checkedAt: new Date().toISOString(),
        });
      }
    }

    if (accepted) {
      timeline.push({
        unitId: planned.unitId,
        fileName: `segments/segment-${index}.mp4`,
        duration: durationForClip,
        sourceUrl: accepted.candidate.url,
        sourceTitle: accepted.candidate.title,
        coverage: "source",
        candidateId: accepted.candidate.id,
      });
    }
  }

  return timeline;
}

async function runPipeline(jobId: string) {
  const job = await readJob(jobId);
  const jobDirectory = getJobDirectory(jobId);
  const audioPath = getJobFile(jobId, job.audioFileName);

  try {
    if (!job.transcript) {
      await setProgress(jobId, 5, "Transcrevendo a narração com Whisper local…", "transcribing");
      const transcriptionPath = path.join(jobDirectory, "audio-for-transcription.mp3");
      const audioForTranscription = await prepareAudioForTranscription(audioPath, transcriptionPath);
      const detectedDuration = await getMediaDuration(audioPath);
      const transcript = normalizeTranscript(await transcribeAudio(audioForTranscription));
      const duration = Math.max(detectedDuration, transcript.duration || 0);
      transcript.duration = duration;
      await setProgress(jobId, 12, "O Luna Max está preparando as perguntas criativas…", "planning");
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

    if (!job.creativeBrief?.submittedAt) throw new Error("A direção criativa ainda não foi respondida.");

    const transcript = job.transcript;
    const duration = Math.max(job.duration || 0, transcript.duration || 0);
    const creativeDirection = creativeBriefToPrompt(job.brief, job.creativeBrief);
    await setProgress(jobId, 22, "O Luna Max está entendendo o que deve aparecer em cada trecho…", "planning");
    let visualPlan: VisualPlan;
    let visualUnits: VisualUnit[];
    let searchResult: { candidates: YouTubeCandidate[]; baseCandidates: YouTubeCandidate[] };
    let allCandidates: YouTubeCandidate[];
    const cachedVisualPlan = job.visualPlan;
    const cachedVisualUnits = job.visualUnits;
    const cachedCandidates = job.candidates;
    const hasCachedPlanning = Boolean(cachedVisualPlan && cachedVisualUnits?.length && cachedCandidates?.length);

    if (hasCachedPlanning && cachedVisualPlan && cachedVisualUnits && cachedCandidates) {
      visualPlan = cachedVisualPlan;
      visualUnits = cachedVisualUnits;
      allCandidates = uniqueCandidates(cachedCandidates);
      searchResult = {
        candidates: allCandidates.filter((candidate) => candidate.unitId !== "base"),
        baseCandidates: allCandidates.filter((candidate) => candidate.unitId === "base"),
      };
      await setProgress(jobId, 34, "Atualizando as fontes visuais encontradas…", "searching");
      const refreshedSearch = await searchCandidates(visualUnits, visualPlan.baseQuery);
      if (refreshedSearch.baseCandidates.length > 0) {
        searchResult = refreshedSearch;
        allCandidates = uniqueCandidates([...searchResult.candidates, ...searchResult.baseCandidates]);
        await saveArtifact(jobId, "search-results.json", { ...searchResult, candidates: allCandidates });
        await updateJob(jobId, { candidates: allCandidates });
      }
      await setProgress(jobId, 42, "Retomando a seleÃ§Ã£o das fontes encontradas…", "planning");
    } else {
      const draftVisualPlan = await createVisualPlan(transcript, creativeDirection, duration);
      visualUnits = ensureVisualCoverage(draftVisualPlan.units, duration);
      visualPlan = { ...draftVisualPlan, units: visualUnits };
    await saveArtifact(jobId, "visual-plan.json", visualPlan);
    await saveArtifact(jobId, "visual-units.json", visualUnits);
    await updateJob(jobId, { visualPlan, visualUnits });

    await setProgress(jobId, 34, "Pesquisando gameplay-base e fontes contextuais no YouTube…", "searching");
    searchResult = await searchCandidates(visualUnits, visualPlan.baseQuery);
    allCandidates = uniqueCandidates([...searchResult.candidates, ...searchResult.baseCandidates]);
    await saveArtifact(jobId, "search-results.json", { ...searchResult, candidates: allCandidates });
    await updateJob(jobId, { candidates: allCandidates });
    }

    await setProgress(jobId, 42, "O Luna Max está ranqueando as fontes e rejeitando vídeos editados…", "planning");
    const draftPlan = await chooseClips(visualUnits, searchResult.candidates, searchResult.baseCandidates, duration, creativeDirection);
    const editPlan = normalizeEditPlan(draftPlan, visualUnits, searchResult.candidates, searchResult.baseCandidates);
    await saveArtifact(jobId, "edit-plan.json", editPlan);
    await updateJob(jobId, { editPlan });

    const verificationDirectory = path.join(jobDirectory, "verification");
    const captionsDirectory = path.join(jobDirectory, "captions");
    await mkdir(verificationDirectory, { recursive: true });
    await mkdir(captionsDirectory, { recursive: true });
    const baseCoverage = await findBaseCoverage({
      jobId,
      jobDirectory,
      duration,
      editPlan,
      baseCandidates: searchResult.baseCandidates,
      baseMustShow: visualPlan.baseMustShow,
      allCandidates,
      verificationDirectory,
    });
    await updateJob(jobId, { baseCoverage, candidates: allCandidates });

    await setProgress(jobId, 58, "Baixando e validando os overlays contextuais…", "downloading");
    const timeline = await findContextualSegments({
      jobId,
      jobDirectory,
      duration,
      units: visualUnits,
      editPlan,
      candidates: searchResult.candidates,
      allCandidates,
      captionsDirectory,
      verificationDirectory,
    });
    await saveArtifact(jobId, "candidate-verifications.json", allCandidates.map((candidate) => ({
      candidateId: candidate.id,
      unitId: candidate.unitId,
      verification: candidate.verification || null,
    })));
    await saveArtifact(jobId, "timeline.json", timeline);

    const editorProject = createEditorProject({ ...job, duration, visualUnits, editPlan, timeline, baseCoverage });
    assertBaseCoverage(editorProject);
    await saveArtifact(jobId, "editor-project.json", editorProject);
    await saveArtifact(jobId, "coverage.json", {
      base: baseCoverage,
      contextualOverlayCount: timeline.length,
      duration,
      guaranteed: true,
    });
    await updateJob(jobId, {
      timeline,
      editorProject,
      baseCoverage,
      candidates: allCandidates,
      editPlan,
      message: timeline.length > 0
        ? `${timeline.length} overlay(s) contextual(is) aprovado(s); a gameplay-base cobre toda a duração.`
        : "Nenhum overlay passou na validação; a gameplay-base cobre toda a duração.",
    });

    await setProgress(jobId, 88, "Renderizando o preview com base contínua e overlays…", "rendering");
    await renderEditorProject({
      jobDirectory,
      project: editorProject,
      narrationPath: audioPath,
      outputPath: getJobFile(jobId, "preview.mp4"),
      quality: "preview",
    });
    await updateJob(jobId, {
      status: "awaiting_approval",
      progress: 100,
      message: "Preview pronto: a gameplay-base cobre toda a narração.",
      media: { preview: "preview.mp4" },
      error: undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha desconhecida no pipeline.";
    await updateJob(jobId, {
      status: "failed",
      progress: 100,
      message: "O job falhou antes de entregar uma timeline incompleta.",
      error: message,
    });
  }
}

export function startJobPipeline(jobId: string) {
  const existing = activeJobs.get(jobId);
  if (existing) return existing;
  const promise = runPipeline(jobId).finally(() => activeJobs.delete(jobId));
  activeJobs.set(jobId, promise);
  return promise;
}

export function startCreativeBriefPipeline(jobId: string) {
  return startJobPipeline(jobId);
}

async function runFinalRender(jobId: string) {
  const job = await readJob(jobId);
  if (!job.editorProject) throw new Error("O job ainda não possui um projeto renderizável.");
  assertBaseCoverage(job.editorProject);
  await updateJob(jobId, { status: "exporting", progress: 10, message: "Exportando a versão final…" });
  await renderEditorProject({
    jobDirectory: getJobDirectory(jobId),
    project: job.editorProject,
    narrationPath: getJobFile(jobId, job.audioFileName),
    outputPath: getJobFile(jobId, "final.mp4"),
    quality: "final",
  });
  await updateJob(jobId, {
    status: "completed",
    progress: 100,
    message: "Exportação final concluída com cobertura visual contínua.",
    media: { ...job.media, final: "final.mp4" },
    error: undefined,
  });
}

async function runEditorPreviewRender(jobId: string) {
  const job = await readJob(jobId);
  if (!job.editorProject) throw new Error("O projeto do editor ainda não foi criado.");
  assertBaseCoverage(job.editorProject);
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
    message: "Preview atualizado com cobertura visual contínua.",
    media: { ...job.media, preview: "preview.mp4" },
    error: undefined,
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
  }).finally(() => activeJobs.delete(jobId));
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
  }).finally(() => activeJobs.delete(jobId));
  activeJobs.set(jobId, promise);
  return promise;
}
