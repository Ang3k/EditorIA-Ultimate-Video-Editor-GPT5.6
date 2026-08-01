import fs from "node:fs";
import OpenAI from "openai";
import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import { getEditorModel, getReasoningEffort, getRequiredEnv } from "./config";
import type {
  EditPlan,
  TranscriptDocument,
  TranscriptSegment,
  TranscriptWord,
  VisualUnit,
  YouTubeCandidate,
} from "./types";

const VisualUnitSchema = z.object({
  id: z.string(),
  start: z.number().nonnegative(),
  end: z.number().positive(),
  narration: z.string(),
  visualBrief: z.string(),
  queries: z.array(z.string()).min(1).max(4),
  mustShow: z.array(z.string()).max(8),
  confidence: z.number().min(0).max(1),
});

const VisualPlanSchema = z.object({
  units: z.array(VisualUnitSchema).min(1),
});

const PlannedClipSchema = z.object({
  unitId: z.string(),
  candidateId: z.string().nullable(),
  sourceStart: z.number().nonnegative(),
  duration: z.number().positive(),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
});

const EditPlanSchema = z.object({
  title: z.string(),
  visualStyle: z.string(),
  clips: z.array(PlannedClipSchema).min(1),
});

let client: OpenAI | undefined;

function getClient() {
  if (!client) {
    client = new OpenAI({ apiKey: getRequiredEnv("OPENAI_API_KEY") });
  }

  return client;
}

function numberOrZero(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function transcribeAudio(filePath: string): Promise<TranscriptDocument> {
  const response = await getClient().audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: "whisper-1",
    response_format: "verbose_json",
    timestamp_granularities: ["segment", "word"],
  } as never);

  const raw = response as unknown as {
    text?: string;
    duration?: number;
    language?: string;
    segments?: Array<{ id?: number; start?: number; end?: number; text?: string }>;
    words?: Array<{ word?: string; start?: number; end?: number }>;
  };

  const segments: TranscriptSegment[] = (raw.segments || []).map((segment, index) => ({
    id: numberOrZero(segment.id ?? index),
    start: numberOrZero(segment.start),
    end: numberOrZero(segment.end),
    text: String(segment.text || "").trim(),
  }));
  const words: TranscriptWord[] = (raw.words || []).map((word) => ({
    word: String(word.word || "").trim(),
    start: numberOrZero(word.start),
    end: numberOrZero(word.end),
  }));

  return {
    text: String(raw.text || "").trim(),
    duration: numberOrZero(raw.duration),
    language: raw.language,
    segments,
    words,
  };
}

function inputForVisualPlan(transcript: TranscriptDocument, brief: string, duration: number) {
  return JSON.stringify(
    {
      brief: brief || "Nenhum contexto adicional foi fornecido.",
      duration,
      transcript: transcript.segments,
      fullText: transcript.text,
    },
    null,
    2,
  );
}

export async function createVisualPlan(
  transcript: TranscriptDocument,
  brief: string,
  duration: number,
): Promise<VisualUnit[]> {
  const response = await getClient().responses.parse({
    model: getEditorModel(),
    reasoning: { effort: getReasoningEffort() as never },
    input: [
      {
        role: "system",
        content: [
          "Você é o diretor editorial de um editor automático de vídeos.",
          "Divida a narração em unidades visuais que possam receber B-roll encontrado no YouTube.",
          "Cada unidade deve representar uma ideia visual concreta, sem inventar fatos que não estejam na narração.",
          "Use tempos em segundos e preserve a ordem da fala.",
          "Crie consultas de busca específicas em português ou inglês quando isso aumentar a chance de encontrar gameplay.",
          "Para cada unidade, descreva o que precisa aparecer e inclua termos que possam ser encontrados em títulos, descrições ou legendas.",
          "Não crie uma unidade para cada palavra: agrupe trechos curtos quando a imagem puder permanecer a mesma.",
        ].join("\n"),
      },
      {
        role: "user",
        content: inputForVisualPlan(transcript, brief, duration),
      },
    ],
    text: { format: zodTextFormat(VisualPlanSchema, "visual_plan") },
  });

  if (!response.output_parsed) {
    throw new Error("A IA não retornou um plano visual estruturado.");
  }

  return response.output_parsed.units as VisualUnit[];
}

export async function chooseClips(
  units: VisualUnit[],
  candidates: YouTubeCandidate[],
  duration: number,
): Promise<EditPlan> {
  const compactCandidates = candidates.map((candidate) => ({
    id: candidate.id,
    unitId: candidate.unitId,
    title: candidate.title,
    description: candidate.description.slice(0, 600),
    channelTitle: candidate.channelTitle,
    url: candidate.url,
  }));

  const response = await getClient().responses.parse({
    model: getEditorModel(),
    reasoning: { effort: getReasoningEffort() as never },
    input: [
      {
        role: "system",
        content: [
          "Você é o montador de B-roll de um editor de vídeo.",
          "Escolha no máximo um candidato por unidade visual e não invente IDs.",
          "O trecho selecionado deve cobrir a ideia narrada; estime sourceStart apenas quando houver uma pista clara no título ou descrição.",
          "Quando não houver um candidato confiável, use candidateId null e confiança baixa.",
          "A duração de cada clipe deve ser compatível com o intervalo da unidade.",
          "O editor vai tentar localizar o momento exato usando legendas automáticas do vídeo e poderá substituir o trecho.",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({ duration, units, candidates: compactCandidates }, null, 2),
      },
    ],
    text: { format: zodTextFormat(EditPlanSchema, "edit_plan") },
  });

  if (!response.output_parsed) {
    throw new Error("A IA não retornou um plano de edição estruturado.");
  }

  return response.output_parsed as EditPlan;
}
