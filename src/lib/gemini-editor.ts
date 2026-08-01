import {
  GoogleGenAI,
  createPartFromUri,
  createUserContent,
} from "@google/genai";
import path from "node:path";
import { z } from "zod";
import { getGeminiModel, getRequiredEnv } from "./config";
import { fallbackCreativeQuestions, normalizeCreativeQuestions } from "./creative-brief";
import type {
  CreativeQuestion,
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
  candidateId: z.string(),
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

const CreativeQuestionSchema = z.object({
  id: z.string(),
  kind: z.enum(["single", "multi", "text"]),
  eyebrow: z.string().optional(),
  question: z.string(),
  helper: z.string().optional(),
  options: z.array(z.object({
    id: z.string(),
    label: z.string(),
    description: z.string().optional(),
  })).optional(),
  placeholder: z.string().optional(),
  required: z.boolean().optional(),
  maxSelections: z.number().int().positive().optional(),
});

const CreativeQuestionSetSchema = z.object({
  questions: z.array(CreativeQuestionSchema).min(1).max(10),
});

const TranscriptSchema = z.object({
  text: z.string(),
  duration: z.number().nonnegative(),
  language: z.string(),
  segments: z.array(
    z.object({
      id: z.number().int().nonnegative(),
      start: z.number().nonnegative(),
      end: z.number().positive(),
      text: z.string(),
    }),
  ),
  words: z.array(
    z.object({
      word: z.string(),
      start: z.number().nonnegative(),
      end: z.number().positive(),
    }),
  ),
});

const visualPlanJsonSchema = {
  type: "object",
  properties: {
    units: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          start: { type: "number" },
          end: { type: "number" },
          narration: { type: "string" },
          visualBrief: { type: "string" },
          queries: { type: "array", items: { type: "string" } },
          mustShow: { type: "array", items: { type: "string" } },
          confidence: { type: "number" },
        },
        required: [
          "id",
          "start",
          "end",
          "narration",
          "visualBrief",
          "queries",
          "mustShow",
          "confidence",
        ],
      },
    },
  },
  required: ["units"],
};

const editPlanJsonSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    visualStyle: { type: "string" },
    clips: {
      type: "array",
      items: {
        type: "object",
        properties: {
          unitId: { type: "string" },
          candidateId: { type: "string" },
          sourceStart: { type: "number" },
          duration: { type: "number" },
          confidence: { type: "number" },
          rationale: { type: "string" },
        },
        required: [
          "unitId",
          "candidateId",
          "sourceStart",
          "duration",
          "confidence",
          "rationale",
        ],
      },
    },
  },
  required: ["title", "visualStyle", "clips"],
};

const creativeQuestionJsonSchema = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      minItems: 6,
      maxItems: 10,
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          kind: { type: "string", enum: ["single", "multi", "text"] },
          eyebrow: { type: "string" },
          question: { type: "string" },
          helper: { type: "string" },
          options: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                label: { type: "string" },
                description: { type: "string" },
              },
              required: ["id", "label"],
            },
          },
          placeholder: { type: "string" },
          required: { type: "boolean" },
          maxSelections: { type: "integer" },
        },
        required: ["id", "kind", "question"],
      },
    },
  },
  required: ["questions"],
};

const transcriptJsonSchema = {
  type: "object",
  properties: {
    text: { type: "string" },
    duration: { type: "number" },
    language: { type: "string" },
    segments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          start: { type: "number" },
          end: { type: "number" },
          text: { type: "string" },
        },
        required: ["id", "start", "end", "text"],
      },
    },
    words: {
      type: "array",
      items: {
        type: "object",
        properties: {
          word: { type: "string" },
          start: { type: "number" },
          end: { type: "number" },
        },
        required: ["word", "start", "end"],
      },
    },
  },
  required: ["text", "duration", "language", "segments", "words"],
};

let client: GoogleGenAI | undefined;

function getClient() {
  if (!client) {
    client = new GoogleGenAI({ apiKey: getRequiredEnv("GEMINI_API_KEY") });
  }

  return client;
}

function parseJson<T>(responseText: string | undefined, schema: z.ZodType<T>) {
  const text = String(responseText || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  if (!text) {
    throw new Error("O Gemini não retornou uma resposta estruturada.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("O Gemini retornou JSON inválido.");
  }

  return schema.parse(parsed);
}

async function generateJson<T>(
  contents: unknown,
  jsonSchema: Record<string, unknown>,
  schema: z.ZodType<T>,
) {
  const response = await getClient().models.generateContent({
    model: getGeminiModel(),
    contents: contents as never,
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: jsonSchema,
    },
  });

  return parseJson(response.text, schema);
}

function mimeTypeForAudio(filePath: string) {
  switch (path.extname(filePath).toLocaleLowerCase()) {
    case ".wav":
      return "audio/wav";
    case ".m4a":
    case ".mp4":
      return "audio/mp4";
    case ".webm":
      return "audio/webm";
    case ".ogg":
      return "audio/ogg";
    case ".flac":
      return "audio/flac";
    case ".aac":
      return "audio/aac";
    default:
      return "audio/mpeg";
  }
}

function numberOrZero(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function transcribeAudio(filePath: string): Promise<TranscriptDocument> {
  const uploadedFile = await getClient().files.upload({
    file: filePath,
    config: { mimeType: mimeTypeForAudio(filePath) },
  });
  if (!uploadedFile.uri) {
    throw new Error("O Gemini não retornou a URI do áudio enviado.");
  }

  const prompt = [
    "Transcreva este áudio em português ou no idioma falado.",
    "Retorne somente JSON conforme o schema fornecido.",
    "Os timestamps de start e end devem ser números em segundos, não strings.",
    "Divida a fala em segmentos naturais e inclua timestamps por palavra quando possível.",
    "Não invente palavras. Se não houver palavras detectadas, retorne words como lista vazia.",
  ].join("\n");

  const raw = await generateJson(
    createUserContent([
      createPartFromUri(uploadedFile.uri, uploadedFile.mimeType || mimeTypeForAudio(filePath)),
      prompt,
    ]),
    transcriptJsonSchema,
    TranscriptSchema,
  );

  const segments: TranscriptSegment[] = raw.segments.map((segment, index) => ({
    id: segment.id ?? index,
    start: numberOrZero(segment.start),
    end: numberOrZero(segment.end),
    text: segment.text.trim(),
  }));
  const words: TranscriptWord[] = raw.words.map((word) => ({
    word: word.word.trim(),
    start: numberOrZero(word.start),
    end: numberOrZero(word.end),
  }));

  return {
    text: raw.text.trim() || segments.map((segment) => segment.text).join(" "),
    duration: numberOrZero(raw.duration),
    language: raw.language,
    segments,
    words,
  };
}

function inputForCreativeQuestions(transcript: TranscriptDocument, brief: string, duration: number) {
  return JSON.stringify(
    {
      duration,
      initialBrief: brief || "",
      transcript: transcript.segments,
      fullText: transcript.text,
    },
    null,
    2,
  );
}

export async function createCreativeQuestions(
  transcript: TranscriptDocument,
  brief: string,
  duration: number,
): Promise<CreativeQuestion[]> {
  const prompt = [
    "Você é um diretor de criação que entrevista o usuário antes de montar um vídeo.",
    "Crie um questionário curto, estratégico e em português para entender como a edição deve ser feita.",
    "Faça entre 8 e 10 perguntas. Priorize respostas selecionáveis em caixas/chips; use kind single para uma escolha, multi para várias escolhas e text somente para uma referência livre.",
    "As perguntas devem ajudar a decidir música, linguagem visual, ritmo, sensação, foco das buscas, texto na tela, formato de publicação e limites da edição.",
    "Use exatamente estes IDs quando fizer sentido: music, visual_language, pacing, tone, search_focus, on_screen_text, format, avoid, creative_note.",
    "As opções devem ser concretas, curtas e mutuamente compreensíveis. Não pergunte sobre coisas que já estão respondidas na narração.",
    "Retorne somente JSON conforme o schema fornecido.",
    "Contexto para personalizar as perguntas:",
    inputForCreativeQuestions(transcript, brief, duration),
  ].join("\n\n");

  try {
    const response = await generateJson(prompt, creativeQuestionJsonSchema, CreativeQuestionSetSchema);
    return normalizeCreativeQuestions(response.questions);
  } catch {
    return fallbackCreativeQuestions();
  }
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
  const prompt = [
    "Você é o diretor editorial de um editor automático de vídeos.",
    "Divida a narração em unidades visuais que possam receber B-roll encontrado no YouTube.",
    "Cada unidade deve representar uma ideia visual concreta, sem inventar fatos.",
    "Use tempos em segundos e preserve a ordem da fala.",
    "Crie de uma a quatro consultas específicas em português ou inglês quando isso aumentar a chance de encontrar gameplay.",
    "Para cada unidade, descreva o que precisa aparecer e inclua termos buscáveis.",
    "Não crie uma unidade para cada palavra; agrupe trechos curtos quando a imagem puder permanecer a mesma.",
    "Retorne somente JSON conforme o schema fornecido.",
    "Dados da narração:",
    inputForVisualPlan(transcript, brief, duration),
  ].join("\n\n");

  const response = await generateJson(prompt, visualPlanJsonSchema, VisualPlanSchema);
  return response.units as VisualUnit[];
}

export async function chooseClips(
  units: VisualUnit[],
  candidates: YouTubeCandidate[],
  duration: number,
  creativeDirection = "",
): Promise<EditPlan> {
  const compactCandidates = candidates.map((candidate) => ({
    id: candidate.id,
    unitId: candidate.unitId,
    title: candidate.title,
    description: candidate.description.slice(0, 600),
    channelTitle: candidate.channelTitle,
    url: candidate.url,
  }));

  const prompt = [
    "Você é o montador de B-roll de um editor de vídeo.",
    "Respeite a direção criativa respondida pelo usuário ao escolher fontes e pontos de corte.",
    "Escolha no máximo um candidato por unidade visual e não invente IDs.",
    "Use candidateId como string vazia quando não houver candidato confiável.",
    "O trecho selecionado deve cobrir a ideia narrada; estime sourceStart apenas quando houver uma pista clara no título ou descrição.",
    "A duração deve ser compatível com o intervalo da unidade.",
    "Retorne somente JSON conforme o schema fornecido.",
    JSON.stringify({ duration, creativeDirection, units, candidates: compactCandidates }, null, 2),
  ].join("\n\n");

  const response = await generateJson(prompt, editPlanJsonSchema, EditPlanSchema);
  return {
    ...response,
    clips: response.clips.map((clip) => ({
      ...clip,
      candidateId: clip.candidateId || null,
    })),
  } as EditPlan;
}
