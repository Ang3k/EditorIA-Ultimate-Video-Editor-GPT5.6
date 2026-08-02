import { z } from "zod";
import { fallbackCreativeQuestions, normalizeCreativeQuestions } from "./creative-brief";
import { runCodexJson } from "./codex-cli";
import { transcribeLocalAudio } from "./local-ai";
import type {
  CandidateVerification,
  CreativeQuestion,
  EditPlan,
  TranscriptDocument,
  TranscriptSegment,
  TranscriptWord,
  VisualPlan,
  VisualUnit,
  YouTubeCandidate,
} from "./types";

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
  maxSelections: z.number().int().nonnegative().optional(),
});

const CreativeQuestionSetSchema = z.object({
  questions: z.array(CreativeQuestionSchema).min(6).max(10),
});

const VisualUnitSchema = z.object({
  id: z.string(),
  start: z.number().nonnegative(),
  end: z.number().positive(),
  narration: z.string(),
  visualBrief: z.string(),
  subject: z.string().optional(),
  action: z.string().optional(),
  location: z.string().optional(),
  queries: z.array(z.string()).max(4),
  mustShow: z.array(z.string()).max(8),
  mustAvoid: z.array(z.string()).max(8).optional(),
  confidence: z.number().min(0).max(1),
});

const VisualPlanSchema = z.object({
  baseQuery: z.string().min(3),
  baseMustShow: z.array(z.string()).max(8),
  units: z.array(VisualUnitSchema).min(1),
});

const PlannedClipSchema = z.object({
  unitId: z.string(),
  candidateIds: z.array(z.string()).max(5),
  sourceStart: z.number().nonnegative(),
  duration: z.number().nonnegative(),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
});

const EditPlanSchema = z.object({
  title: z.string(),
  visualStyle: z.string(),
  baseQuery: z.string().min(3),
  baseCandidateIds: z.array(z.string()).max(8),
  clips: z.array(PlannedClipSchema),
});

const CandidateVerificationSchema = z.object({
  status: z.enum(["approved", "rejected"]),
  directMatchScore: z.number().min(0).max(1),
  rawFootage: z.boolean(),
  editedCreatorRisk: z.boolean(),
  blackFrameRisk: z.boolean(),
  sourceKind: z.enum(["raw_gameplay", "cutscene", "official_footage", "edited_creator", "unknown"]),
  evidence: z.array(z.string()).max(8),
  rejectionReason: z.string().optional(),
});

const creativeQuestionJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    questions: {
      type: "array",
      minItems: 6,
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
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
              additionalProperties: false,
              properties: {
                id: { type: "string" },
                label: { type: "string" },
                description: { type: "string" },
              },
              required: ["id", "label", "description"],
            },
          },
          placeholder: { type: "string" },
          required: { type: "boolean" },
          maxSelections: { type: "integer" },
        },
        required: ["id", "kind", "eyebrow", "question", "helper", "options", "placeholder", "required", "maxSelections"],
      },
    },
  },
  required: ["questions"],
};

const visualPlanJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    baseQuery: { type: "string" },
    baseMustShow: { type: "array", items: { type: "string" } },
    units: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          start: { type: "number" },
          end: { type: "number" },
          narration: { type: "string" },
          visualBrief: { type: "string" },
          subject: { type: "string" },
          action: { type: "string" },
          location: { type: "string" },
          queries: { type: "array", items: { type: "string" } },
          mustShow: { type: "array", items: { type: "string" } },
          mustAvoid: { type: "array", items: { type: "string" } },
          confidence: { type: "number" },
        },
        required: ["id", "start", "end", "narration", "visualBrief", "subject", "action", "location", "queries", "mustShow", "mustAvoid", "confidence"],
      },
    },
  },
  required: ["baseQuery", "baseMustShow", "units"],
};

const editPlanJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    visualStyle: { type: "string" },
    baseQuery: { type: "string" },
    baseCandidateIds: { type: "array", items: { type: "string" } },
    clips: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          unitId: { type: "string" },
          candidateIds: { type: "array", items: { type: "string" } },
          sourceStart: { type: "number" },
          duration: { type: "number" },
          confidence: { type: "number" },
          rationale: { type: "string" },
        },
        required: ["unitId", "candidateIds", "sourceStart", "duration", "confidence", "rationale"],
      },
    },
  },
  required: ["title", "visualStyle", "baseQuery", "baseCandidateIds", "clips"],
};

const candidateVerificationJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["approved", "rejected"] },
    directMatchScore: { type: "number" },
    rawFootage: { type: "boolean" },
    editedCreatorRisk: { type: "boolean" },
    blackFrameRisk: { type: "boolean" },
    sourceKind: { type: "string", enum: ["raw_gameplay", "cutscene", "official_footage", "edited_creator", "unknown"] },
    evidence: { type: "array", items: { type: "string" } },
    rejectionReason: { type: "string" },
  },
  required: ["status", "directMatchScore", "rawFootage", "editedCreatorRisk", "blackFrameRisk", "sourceKind", "evidence", "rejectionReason"],
};

function inputForCreativeQuestions(transcript: TranscriptDocument, brief: string, duration: number) {
  return JSON.stringify({
    duration,
    initialBrief: brief || "",
    transcript: transcript.segments,
    fullText: transcript.text,
  }, null, 2);
}

function inputForVisualPlan(transcript: TranscriptDocument, brief: string, duration: number) {
  return JSON.stringify({
    duration,
    creativeDirection: brief || "Nenhuma direção adicional foi fornecida.",
    transcript: transcript.segments,
    fullText: transcript.text,
  }, null, 2);
}

export async function transcribeAudio(filePath: string): Promise<TranscriptDocument> {
  return transcribeLocalAudio(filePath);
}

export async function createCreativeQuestions(
  transcript: TranscriptDocument,
  brief: string,
  duration: number,
): Promise<CreativeQuestion[]> {
  const prompt = [
    "Você é o diretor criativo de um editor de vídeo e está atendendo uma aplicação local.",
    "Não altere arquivos, não execute comandos e não explique seu raciocínio.",
    "Retorne somente um objeto JSON válido conforme o schema.",
    "Crie de 8 a 10 perguntas estratégicas em português para orientar a montagem depois da transcrição.",
    "Priorize perguntas respondidas por caixas/chips: single para uma escolha e multi para várias escolhas; use text apenas quando uma referência livre for realmente útil.",
    "Cubra música, linguagem visual, ritmo, tom, foco das buscas, texto na tela, formato, limites e referências.",
    "Use estes IDs quando fizer sentido: music, visual_language, pacing, tone, search_focus, on_screen_text, format, avoid, creative_note.",
    "Não pergunte novamente algo que a narração já determinou. As opções devem ser concretas e mutuamente compreensíveis.",
    "CONTEXTO:",
    inputForCreativeQuestions(transcript, brief, duration),
  ].join("\n\n");

  const response = await runCodexJson({
    prompt,
    schema: creativeQuestionJsonSchema,
    stage: "creative-questions",
    parse: (value) => CreativeQuestionSetSchema.parse(value),
  });
  return normalizeCreativeQuestions(response.questions);
}

export async function createVisualPlan(
  transcript: TranscriptDocument,
  brief: string,
  duration: number,
): Promise<VisualPlan> {
  const prompt = [
    "Você é um diretor editorial especializado em vídeo-ensaio e gameplay.",
    "Não altere arquivos, não execute comandos e não explique seu raciocínio. Retorne somente JSON válido conforme o schema.",
    "A regra central é correspondência visual direta: cada unidade precisa representar exatamente o sujeito, a ação/evento e o local/cena falados naquele intervalo.",
    "O tema geral do jogo, franquia ou personagem nunca é suficiente para justificar um clipe.",
    "Para cada unidade, preencha subject, action e location quando existirem e transforme esses elementos em consultas específicas.",
    "Não use consultas genéricas como gameplay do jogo, lore, melhores momentos, teoria ou nome isolado de personagem.",
    "Prefira gameplay bruto, playthrough, walkthrough, cutscene ou no commentary. Evite theory, analysis, essay, reaction, review, podcast, shorts, compilation, montage, fan animation e vídeos editados por outros criadores.",
    "Se uma ideia não tiver uma imagem direta provável, use queries vazias e confiança baixa; é melhor deixar a gameplay-base aparecer do que inventar uma relação.",
    "Agrupe falas que possam usar a mesma cena, mas não reutilize uma intenção visual diferente em unidades sem relação.",
    "Além das unidades, crie baseQuery para uma gameplay longa, bruta e no commentary do mesmo jogo/tema, capaz de manter o vídeo preenchido do início ao fim.",
    "CONTEXTO DA NARRAÇÃO:",
    inputForVisualPlan(transcript, brief, duration),
  ].join("\n\n");

  return runCodexJson({
    prompt,
    schema: visualPlanJsonSchema,
    stage: "visual-plan",
    parse: (value) => VisualPlanSchema.parse(value),
  });
}

function candidateSummary(candidate: YouTubeCandidate) {
  return {
    id: candidate.id,
    unitId: candidate.unitId,
    title: candidate.title,
    description: candidate.description.slice(0, 900),
    channelTitle: candidate.channelTitle,
    duration: candidate.duration || null,
    sourceKind: candidate.sourceKind || "unknown",
    url: candidate.url,
  };
}

export async function chooseClips(
  units: VisualUnit[],
  candidates: YouTubeCandidate[],
  baseCandidates: YouTubeCandidate[],
  duration: number,
  creativeDirection = "",
): Promise<EditPlan> {
  const unitCandidateSets = units.map((unit) => ({
    unitId: unit.id,
    narration: unit.narration,
    visualBrief: unit.visualBrief,
    subject: unit.subject || "",
    action: unit.action || "",
    location: unit.location || "",
    queries: unit.queries,
    mustShow: unit.mustShow,
    mustAvoid: unit.mustAvoid || [],
    candidates: candidates.filter((candidate) => candidate.unitId === unit.id).map(candidateSummary),
  }));

  const prompt = [
    "Você é o montador de B-roll de um editor de vídeo.",
    "Não altere arquivos, não execute comandos e não explique seu raciocínio. Retorne somente JSON válido conforme o schema.",
    "Escolha somente candidatos que correspondam diretamente ao sujeito, ação, local e elementos obrigatórios da unidade.",
    "Cada clip deve conter uma lista candidateIds ordenada do melhor para o pior, com no máximo cinco IDs do próprio grupo.",
    "Nunca invente IDs e nunca use um candidato de outra unidade.",
    "Rejeite vídeos de teoria, explicação, reação, análise, lore, review, podcast, shorts, compilação, montagem, animação, comic dub ou gameplay editada de outro criador.",
    "Quando não existir uma fonte diretamente relevante, candidateIds deve ser uma lista vazia. Um intervalo sem overlay é melhor que um vídeo aleatório.",
    "Escolha sourceStart somente quando houver uma pista clara; use o intervalo da unidade como duration.",
    "Também selecione baseCandidateIds ordenados: devem ser vídeos longos de gameplay bruta/no commentary do mesmo jogo, sem apresentador, facecam ou edição de outro YouTuber.",
    "DIREÇÃO RESPONDIDA PELO USUÁRIO:",
    creativeDirection || "Nenhuma direção adicional.",
    "DURAÇÃO:",
    String(duration),
    "CANDIDATOS-BASE:",
    JSON.stringify(baseCandidates.map(candidateSummary), null, 2),
    "CANDIDATOS POR UNIDADE:",
    JSON.stringify(unitCandidateSets, null, 2),
  ].join("\n\n");

  const response = await runCodexJson({
    prompt,
    schema: editPlanJsonSchema,
    stage: "clip-selection",
    parse: (value) => EditPlanSchema.parse(value),
  });
  return {
    ...response,
    clips: response.clips.map((clip) => ({
      ...clip,
      candidateId: null,
      candidateIds: clip.candidateIds,
    })),
  };
}

export async function verifyCandidate(input: {
  candidate: YouTubeCandidate;
  unit?: VisualUnit;
  baseMustShow?: string[];
  imagePaths: string[];
  jobDirectory?: string;
}): Promise<CandidateVerification> {
  const isBase = !input.unit;
  const prompt = [
    "Você é o verificador visual de um editor de vídeo.",
    "Não altere arquivos, não execute comandos e retorne somente JSON conforme o schema.",
    "As imagens anexadas são frames reais do trecho baixado. Use evidência visual, não apenas o título, para decidir.",
    isBase
      ? "Para uma fonte-base, aprove somente gameplay/cutscene real do jogo/tema pedido, sem apresentador, facecam, compilação, montagem, edição de outro criador ou tela predominantemente preta."
      : "Para um overlay, aprove somente se os frames mostrarem diretamente o sujeito, ação/evento e cena descritos na narração. Relação apenas com o jogo/personagem não basta.",
    "rawFootage deve ser false quando houver sinais de vídeo editorial de outro YouTuber, cortes de montagem, comentários visuais, facecam ou compilação.",
    "editedCreatorRisk deve ser true quando houver qualquer risco relevante de estar usando conteúdo editado de outro criador.",
    "blackFrameRisk deve ser true se os frames forem predominantemente pretos ou não houver conteúdo visual útil.",
    "Aprovar significa status=approved, rawFootage=true, editedCreatorRisk=false, blackFrameRisk=false e directMatchScore >= 0.75.",
    "CANDIDATO:",
    JSON.stringify(candidateSummary(input.candidate), null, 2),
    "UNIDADE:",
    JSON.stringify(input.unit ? {
      narration: input.unit.narration,
      visualBrief: input.unit.visualBrief,
      subject: input.unit.subject || "",
      action: input.unit.action || "",
      location: input.unit.location || "",
      mustShow: input.unit.mustShow,
      mustAvoid: input.unit.mustAvoid || [],
    } : { baseMustShow: input.baseMustShow || [] }, null, 2),
  ].join("\n\n");

  const response = await runCodexJson({
    prompt,
    schema: candidateVerificationJsonSchema,
    stage: `verify-${input.candidate.id}`,
    jobDirectory: input.jobDirectory,
    images: input.imagePaths,
    parse: (value) => CandidateVerificationSchema.parse(value),
  });
  const accepted = response.status === "approved"
    && response.rawFootage
    && !response.editedCreatorRisk
    && !response.blackFrameRisk
    && response.directMatchScore >= 0.75;
  return {
    ...response,
    status: accepted ? "approved" : "rejected",
    rejectionReason: accepted ? undefined : response.rejectionReason || "A fonte não passou pela validação visual de segurança.",
    checkedAt: new Date().toISOString(),
  };
}

export function normalizeTranscript(raw: TranscriptDocument): TranscriptDocument {
  const segments: TranscriptSegment[] = raw.segments.map((segment, index) => ({
    id: segment.id ?? index,
    start: Number.isFinite(segment.start) ? segment.start : 0,
    end: Math.max(Number.isFinite(segment.end) ? segment.end : segment.start + 0.01, segment.start + 0.01),
    text: segment.text.trim(),
  }));
  const words: TranscriptWord[] = raw.words.map((word) => ({
    word: word.word.trim(),
    start: Number.isFinite(word.start) ? word.start : 0,
    end: Math.max(Number.isFinite(word.end) ? word.end : word.start + 0.01, word.start + 0.01),
  }));
  return {
    ...raw,
    text: raw.text.trim() || segments.map((segment) => segment.text).join(" "),
    segments,
    words,
  };
}

export function fallbackQuestionsForUnavailableRuntime() {
  return fallbackCreativeQuestions();
}
