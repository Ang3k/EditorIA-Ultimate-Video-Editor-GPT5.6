"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import type { CreativeQuestion, JobState } from "@/lib/types";

interface CreativeBriefFormProps {
  job: JobState;
  onSubmitted?: (job: JobState) => void;
  compact?: boolean;
}

function formatTime(seconds = 0) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const minutes = Math.floor(safe / 60);
  const rest = Math.floor(safe % 60).toString().padStart(2, "0");
  return `${minutes}:${rest}`;
}

function answerValues(answers: Record<string, string | string[]>, question: CreativeQuestion) {
  const answer = answers[question.id];
  return Array.isArray(answer) ? answer : answer ? [answer] : [];
}

function isAnswered(answers: Record<string, string | string[]>, question: CreativeQuestion) {
  return answerValues(answers, question).length > 0;
}

export default function CreativeBriefForm({ job, onSubmitted, compact = false }: CreativeBriefFormProps) {
  const questions = job.creativeBrief?.questions || [];
  const [answers, setAnswers] = useState<Record<string, string | string[]>>(() => job.creativeBrief?.answers || {});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const requiredQuestions = questions.filter((question) => question.required);
  const answeredRequired = requiredQuestions.filter((question) => isAnswered(answers, question)).length;
  const missingRequired = answeredRequired < requiredQuestions.length;

  function choose(question: CreativeQuestion, value: string) {
    setNotice("");
    setAnswers((current) => {
      if (question.kind === "single") return { ...current, [question.id]: value };
      const currentValues = answerValues(current, question);
      const nextValues = currentValues.includes(value)
        ? currentValues.filter((item) => item !== value)
        : [...currentValues, value].slice(0, question.maxSelections || 8);
      return { ...current, [question.id]: nextValues };
    });
  }

  function updateText(question: CreativeQuestion, value: string) {
    setNotice("");
    setAnswers((current) => ({ ...current, [question.id]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (missingRequired) {
      setNotice("Responda às decisões marcadas com · antes de continuar.");
      return;
    }

    setBusy(true);
    setNotice("");
    try {
      const response = await fetch(`/api/jobs/${job.id}/brief`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers }),
      });
      const data = (await response.json()) as JobState & { error?: string };
      if (!response.ok) {
        setNotice(data.error || "Não foi possível enviar a direção criativa.");
        return;
      }
      onSubmitted?.(data);
    } catch {
      setNotice("Não foi possível enviar a direção criativa.");
    } finally {
      setBusy(false);
    }
  }

  if (!job.creativeBrief || questions.length === 0) return null;

  return (
    <form className={`creative-brief-form ${compact ? "compact" : ""}`} onSubmit={submit}>
      <div className="creative-brief-head">
        <div>
          <p className="eyebrow accent">AI CREATIVE BRIEF · ANTES DA BUSCA</p>
          <h2>Me dê a direção antes de eu escolher as imagens.</h2>
          <p className="creative-brief-lede">A narração já foi entendida. Agora suas escolhas ajudam a decidir o que procurar, onde cortar e qual sensação o vídeo deve ter.</p>
        </div>
        <div className="creative-brief-meta">
          <span><i /> Narração pronta</span>
          <span>{formatTime(job.duration)} de áudio</span>
          <span>{questions.length} decisões</span>
        </div>
      </div>

      <div className="creative-brief-progress">
        <div><span>Direção essencial</span><strong>{answeredRequired}/{requiredQuestions.length}</strong></div>
        <span className="creative-brief-progress-track"><i style={{ width: `${requiredQuestions.length ? (answeredRequired / requiredQuestions.length) * 100 : 100}%` }} /></span>
      </div>

      <div className="creative-question-list">
        {questions.map((question, index) => {
          const selectedValues = answerValues(answers, question);
          const answered = isAnswered(answers, question);
          return (
            <section className={`creative-question ${answered ? "answered" : ""}`} key={question.id}>
              <div className="creative-question-heading">
                <div>
                  <span className="creative-question-index">{String(index + 1).padStart(2, "0")}</span>
                  <span className="eyebrow">{question.eyebrow || "DIREÇÃO"}{question.required ? " · OBRIGATÓRIA" : " · OPCIONAL"}</span>
                </div>
                {answered && <span className="creative-question-check">✓ definido</span>}
              </div>
              <h3>{question.question}</h3>
              {question.helper && <p className="creative-question-helper">{question.helper}</p>}

              {question.kind === "text" ? (
                <textarea
                  value={typeof answers[question.id] === "string" ? answers[question.id] : ""}
                  onChange={(event) => updateText(question, event.target.value)}
                  placeholder={question.placeholder || "Escreva uma referência ou preferência..."}
                  rows={compact ? 3 : 4}
                />
              ) : (
                <div className={`creative-options ${question.kind === "multi" ? "multi" : ""}`}>
                  {(question.options || []).map((option) => {
                    const selected = selectedValues.includes(option.id);
                    return (
                      <button
                        type="button"
                        className={`creative-option ${selected ? "selected" : ""}`}
                        key={option.id}
                        aria-pressed={selected}
                        onClick={() => choose(question, option.id)}
                      >
                        <span className="creative-option-mark">{selected ? "✓" : question.kind === "multi" ? "□" : "○"}</span>
                        <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      </div>

      <div className="creative-brief-footer">
        <div><span className="pulse" /> As respostas serão usadas na transcrição visual, nas buscas e na montagem.</div>
        <button className="creative-submit" type="submit" disabled={busy || missingRequired}>
          {busy ? "Preparando buscas…" : "Usar esta direção e buscar vídeos"}<span>→</span>
        </button>
      </div>
      {notice && <p className="creative-brief-notice">{notice}</p>}
    </form>
  );
}
