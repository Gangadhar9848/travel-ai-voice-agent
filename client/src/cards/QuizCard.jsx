import { useState } from 'react';

const ICONS = {
  Q01: { A: '🏖️', B: '🧺', C: '🏔️', D: '☕' },
  Q02: { A: '🧘', B: '🧭', C: '⚡', D: '🎒' },
  Q03: { A: '🍷', B: '🍸', C: '🌅', D: '🌙' },
};
export const answerIcon = (q, a) => ICONS[q]?.[a] ?? '✨';

/** 3-step mood quiz. onDone([{question_id, answer_id, text}]) */
export default function QuizCard({ quiz, answered, onDone, disabled }) {
  const [step, setStep] = useState(0);
  const [picks, setPicks] = useState([]);

  if (answered) {
    return (
      <div className="card quiz done">
        <div className="card-title">✨ Mood quiz</div>
        <div className="quiz-summary">
          {answered.map((a) => (
            <span key={a.question_id} className="chip">{answerIcon(a.question_id, a.answer_id)} {a.text}</span>
          ))}
        </div>
      </div>
    );
  }

  const q = quiz[step];
  const choose = (a) => {
    const next = [...picks, { question_id: q.id, answer_id: a.id, text: a.text }];
    if (step + 1 < quiz.length) { setPicks(next); setStep(step + 1); }
    else onDone(next);
  };

  return (
    <div className="card quiz">
      <div className="quiz-head">
        <span className="card-title">✨ Find your perfect holiday</span>
        <span className="quiz-step">{step + 1} / {quiz.length}</span>
      </div>
      <div className="quiz-progress"><i style={{ width: `${((step + 1) / quiz.length) * 100}%` }} /></div>
      <h4>{q.question}</h4>
      <div className="quiz-options">
        {q.answers.map((a) => (
          <button key={a.id} disabled={disabled} onClick={() => choose(a)}>
            <span className="quiz-icon">{answerIcon(q.id, a.id)}</span>
            <span>{a.text}</span>
          </button>
        ))}
      </div>
      {step > 0 && (
        <button className="link small" onClick={() => { setStep(step - 1); setPicks(picks.slice(0, -1)); }}>← Back</button>
      )}
    </div>
  );
}
