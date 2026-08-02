import type {
  CreativeBrief,
  CreativeQuestion,
  CreativeQuestionKind,
  CreativeQuestionOption,
} from "./types";

const SINGLE_QUESTION_IDS = new Set([
  "music",
  "visual_language",
  "pacing",
  "tone",
  "on_screen_text",
  "format",
]);

function option(id: string, label: string, description?: string): CreativeQuestionOption {
  return { id, label, ...(description ? { description } : {}) };
}

export function fallbackCreativeQuestions(): CreativeQuestion[] {
  return [
    {
      id: "music",
      kind: "single",
      eyebrow: "TRILHA",
      question: "Você gostaria de música no vídeo?",
      helper: "A trilha pode criar ritmo e emoção sem disputar com a narração.",
      required: true,
      options: [
        option("music_subtle", "Sim, discreta", "Uma cama musical baixa, sustentando a fala."),
        option("music_present", "Sim, mais presente", "A música também participa da emoção da montagem."),
        option("music_none", "Não", "Só narração e sons pontuais do material."),
        option("music_unsure", "Ainda não sei", "Deixe a IA sugerir com base no tema."),
      ],
    },
    {
      id: "visual_language",
      kind: "single",
      eyebrow: "IMAGEM",
      question: "Que tipo de imagem deve dominar o vídeo?",
      helper: "Isso orienta o que a IA deve considerar uma boa fonte visual.",
      required: true,
      options: [
        option("gameplay", "Gameplay", "A ação do jogo como protagonista."),
        option("cinematic", "Cenas cinematográficas", "Cutscenes, trailers e momentos dirigidos."),
        option("details", "Detalhes e atmosfera", "Cenários, personagens, menus e planos de apoio."),
        option("mixed", "Mistura dos três", "Varie conforme a ideia de cada trecho."),
      ],
    },
    {
      id: "pacing",
      kind: "single",
      eyebrow: "MONTAGEM",
      question: "Qual ritmo de corte combina com a narração?",
      helper: "A duração dos planos e a intensidade das trocas serão ajustadas a partir daqui.",
      required: true,
      options: [
        option("calm", "Calmo", "Planos mais longos e transições suaves."),
        option("narration", "Acompanhando a fala", "Trocas nos pontos em que a ideia muda."),
        option("dynamic", "Dinâmico", "Mais variedade visual e cortes frequentes."),
        option("dramatic", "Dramático", "Segure a imagem e corte para dar impacto."),
      ],
    },
    {
      id: "tone",
      kind: "single",
      eyebrow: "SENSAÇÃO",
      question: "Que sensação você quer deixar em quem assistir?",
      required: true,
      options: [
        option("curious", "Curiosidade", "Revelar pistas e estimular a descoberta."),
        option("emotional", "Emoção", "Valorizar momentos humanos e uma trilha envolvente."),
        option("tense", "Tensão", "Criar expectativa e sensação de perigo."),
        option("epic", "Épico", "Dar escala, força e sensação de acontecimento."),
        option("intimate", "Íntimo", "Mais proximidade, reflexão e respiro."),
      ],
    },
    {
      id: "search_focus",
      kind: "multi",
      eyebrow: "BUSCA",
      question: "O que a IA deve priorizar ao procurar os vídeos?",
      helper: "Escolha até três focos. Eles serão convertidos em buscas específicas para cada trecho.",
      maxSelections: 3,
      options: [
        option("exact_subject", "O assunto exato da fala"),
        option("characters", "Personagens e rostos"),
        option("actions", "Ações e gameplay"),
        option("world", "Cenários e atmosfera"),
        option("cutscenes", "Cenas e trailers oficiais"),
        option("closeups", "Detalhes, itens e interfaces"),
      ],
    },
    {
      id: "on_screen_text",
      kind: "single",
      eyebrow: "GRÁFICOS",
      question: "Você quer texto aparecendo na tela?",
      helper: "A narração continua sendo a trilha principal; isto define apenas a camada visual.",
      required: true,
      options: [
        option("none", "Sem texto", "A imagem e a voz conduzem tudo."),
        option("keywords", "Palavras-chave", "Poucas palavras para marcar conceitos importantes."),
        option("captions", "Legendas", "Texto acompanhando toda a narração."),
        option("titles", "Títulos e chamadas", "Cartelas pontuais para organizar o argumento."),
      ],
    },
    {
      id: "format",
      kind: "single",
      eyebrow: "ENTREGA",
      question: "Onde esse vídeo vai ser publicado?",
      helper: "O formato muda o enquadramento e quais partes do material podem funcionar melhor.",
      required: true,
      options: [
        option("landscape", "YouTube 16:9", "Tela horizontal tradicional."),
        option("vertical", "Shorts / Reels 9:16", "Tela vertical, com foco no centro da ação."),
        option("square", "Feed 1:1", "Composição quadrada para redes sociais."),
        option("undecided", "Ainda não sei", "Mantenha a composição mais flexível."),
      ],
    },
    {
      id: "avoid",
      kind: "multi",
      eyebrow: "LIMITES",
      question: "Existe algo que a edição deve evitar?",
      helper: "Opcional. Marque tudo o que costuma deixar seu vídeo com a cara errada.",
      maxSelections: 4,
      options: [
        option("unrelated", "Imagens genéricas ou sem relação"),
        option("repetition", "Repetir o mesmo tipo de plano"),
        option("fast_cuts", "Cortes rápidos demais"),
        option("loud_music", "Música cobrindo a narração"),
        option("too_much_text", "Texto demais na tela"),
        option("spoilers", "Cenas que entreguem spoilers"),
      ],
    },
    {
      id: "creative_note",
      kind: "text",
      eyebrow: "REFERÊNCIA",
      question: "Tem alguma referência, cena ou preferência que eu deveria conhecer?",
      helper: "Escreva livremente. Pode ser uma comparação, um canal, uma cena ou simplesmente o que você imaginou.",
      placeholder: "Ex.: quero algo como um ensaio de videogame, com planos longos no começo e mais energia quando a teoria for revelada.",
    },
  ];
}

function cleanKind(value: unknown, fallback: CreativeQuestionKind): CreativeQuestionKind {
  return value === "single" || value === "multi" || value === "text" ? value : fallback;
}

function cleanOptions(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((rawOption) => {
    if (!rawOption || typeof rawOption !== "object") return [];
    const item = rawOption as Record<string, unknown>;
    const id = String(item.id || "").trim();
    const label = String(item.label || "").trim();
    if (!id || !label) return [];
    return [option(id, label, String(item.description || "").trim() || undefined)];
  }).slice(0, 8);
}

function cleanQuestion(raw: unknown, fallback?: CreativeQuestion): CreativeQuestion | null {
  if (!raw || typeof raw !== "object") return fallback || null;
  const value = raw as Record<string, unknown>;
  const id = String(value.id || fallback?.id || "").trim();
  const question = String(value.question || fallback?.question || "").trim();
  if (!id || !question) return fallback || null;
  const kind = cleanKind(value.kind, fallback?.kind || (SINGLE_QUESTION_IDS.has(id) ? "single" : "text"));
  const options = cleanOptions(value.options);
  return {
    id,
    kind,
    eyebrow: String(value.eyebrow || fallback?.eyebrow || "").trim() || undefined,
    question,
    helper: String(value.helper || fallback?.helper || "").trim() || undefined,
    options: kind === "text" ? undefined : (options.length > 0 ? options : fallback?.options || []),
    placeholder: String(value.placeholder || fallback?.placeholder || "").trim() || undefined,
    required: typeof value.required === "boolean" ? value.required : fallback?.required,
    maxSelections: typeof value.maxSelections === "number" && value.maxSelections > 0
      ? value.maxSelections
      : fallback?.maxSelections,
  };
}

export function normalizeCreativeQuestions(raw: unknown): CreativeQuestion[] {
  const fallback = fallbackCreativeQuestions();
  const fallbackById = new Map(fallback.map((question) => [question.id, question]));
  const generated = Array.isArray(raw) ? raw : [];
  const generatedById = new Map(
    generated
      .map((item) => cleanQuestion(item))
      .filter((question): question is CreativeQuestion => Boolean(question))
      .map((question) => [question.id, question]),
  );

  const questions = fallback.map((question) => cleanQuestion(generatedById.get(question.id), question) || question);
  for (const [id, question] of generatedById) {
    if (!fallbackById.has(id) && questions.length < 10) questions.push(question);
  }
  return questions;
}

function allowedOptionIds(question: CreativeQuestion) {
  return new Set((question.options || []).map((item) => item.id));
}

export function normalizeCreativeAnswers(
  questions: CreativeQuestion[],
  rawAnswers: unknown,
): Record<string, string | string[]> {
  const source = rawAnswers && typeof rawAnswers === "object" ? rawAnswers as Record<string, unknown> : {};
  return Object.fromEntries(questions.map((question) => {
    const allowed = allowedOptionIds(question);
    if (question.kind === "text") return [question.id, String(source[question.id] || "").trim()];
    if (question.kind === "multi") {
      const values = Array.isArray(source[question.id]) ? source[question.id] as unknown[] : [];
      return [question.id, values.map(String).filter((value) => allowed.has(value)).slice(0, question.maxSelections || 8)];
    }
    const value = String(source[question.id] || "");
    return [question.id, allowed.has(value) ? value : ""];
  }));
}

export function creativeBriefHasRequiredAnswers(brief: CreativeBrief) {
  return brief.questions.every((question) => {
    if (!question.required) return true;
    const answer = brief.answers[question.id];
    return Array.isArray(answer) ? answer.length > 0 : Boolean(String(answer || "").trim());
  });
}

export function creativeBriefToPrompt(initialBrief: string, creativeBrief?: CreativeBrief) {
  const lines = [initialBrief.trim() ? `Contexto inicial do usuário: ${initialBrief.trim()}` : "Nenhum contexto inicial foi fornecido."];
  if (!creativeBrief) return lines.join("\n");

  lines.push("Direção criativa respondida pelo usuário:");
  for (const question of creativeBrief.questions) {
    const answer = creativeBrief.answers[question.id];
    const values = Array.isArray(answer) ? answer : [answer];
    const labels = values.filter(Boolean).map((value) => {
      const match = question.options?.find((item) => item.id === value);
      return match ? `${match.label}${match.description ? ` (${match.description})` : ""}` : String(value);
    });
    if (labels.length > 0) lines.push(`- ${question.question}: ${labels.join(", ")}`);
  }
  return lines.join("\n");
}
