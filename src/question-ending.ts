import type { Transcript } from "./worker.ts";

type Cue = Transcript["segments"][number];
type TimedWord = Cue & { probability: number };

function tokens(line: string): string[] {
  return (
    line
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? []
  );
}

const auxiliaryFamily: Record<string, string> = {
  can: "can",
  "can't": "can",
  cannot: "can",
  could: "could",
  "couldn't": "could",
  do: "do",
  "don't": "do",
  does: "do",
  "doesn't": "do",
  did: "did",
  "didn't": "did",
  will: "will",
  "won't": "will",
  would: "would",
  "wouldn't": "would",
  is: "be",
  "isn't": "be",
  am: "be",
  are: "be",
  "aren't": "be",
  was: "was",
  "wasn't": "was",
  were: "was",
  "weren't": "was",
  have: "have",
  "haven't": "have",
  has: "have",
  "hasn't": "have",
  should: "should",
  "shouldn't": "should",
};
const subjects: Record<string, string[]> = {
  you: ["i", "we", "you"],
  i: ["you", "i"],
  we: ["we", "you"],
  it: ["it", "that"],
  he: ["he"],
  she: ["she"],
  they: ["they"],
  there: ["there"],
};
const minorWords = new Set(
  "what where when which why how who the this that these those inside into with from about your mine there then just does have did you they and for would could should".split(
    " ",
  ),
);

function directReply(question: string, answer: string) {
  if (answer.includes("?")) return false;
  const lastSentence =
    question
      .trim()
      .split(/[.!?]+/)
      .filter((s) => s.trim())
      .at(-1) ?? "";
  const q = tokens(lastSentence.replace(/^\s*(?:so|hey|wait|okay)[,\s]+/i, "")),
    a = tokens(answer);
  if (!q.length || !a.length || a.length > 22) return false;
  const polar = auxiliaryFamily[q[0]];
  const yesNo = /^(yes|yeah|yep|yup|no|nope|nah)$/.test(a[0]);
  if (polar && yesNo && a.length === 1) return true;
  const response = yesNo ? a.slice(1) : a;
  const subject = subjects[q[1]] ?? ["it", "they", "he", "she"];
  const echo =
    polar &&
    subject.includes(response[0]) &&
    auxiliaryFamily[response[1]] === polar;
  if (
    echo &&
    (response.length === 2 || (response.length === 3 && response[2] === "not"))
  )
    return true;
  // A longer answer needs a topic word from the question. Mere adjacency or "yeah" is insufficient.
  const shared = response.some(
    (w) =>
      w.length > 2 &&
      !minorWords.has(w) &&
      !auxiliaryFamily[w] &&
      q.slice(1).includes(w),
  );
  if (polar) return shared && Boolean(echo || yesNo);
  // A short standalone place, time or count can answer without repeating a noun.
  const fragment = response.join(" ");
  if (
    q[0] === "where" &&
    /^(?:at|by|in|inside|near|outside|behind|under|to) (?:the |a |our |my |your )[a-z]+(?: [a-z]+){0,2}$/.test(
      fragment,
    )
  )
    return !response.some(
      (w) =>
        ["i", "you", "we", "he", "she", "they", "it", "and", "but"].includes(
          w,
        ) || auxiliaryFamily[w],
    );
  if (
    q[0] === "when" &&
    /^(?:today|tomorrow|tonight|yesterday|(?:at|around) (?:noon|midnight|[0-9]{1,2}(?: [ap]m)?)|(?:in|after) (?:a|one|two|[0-9]+) (?:minutes?|hours?|days?))$/.test(
      fragment,
    )
  )
    return true;
  if (
    q[0] === "how" &&
    q[1] === "many" &&
    /^(?:none|one|two|three|four|five|six|seven|eight|nine|ten|[0-9]+)$/.test(
      fragment,
    )
  )
    return true;
  if (!shared) return false;
  return (
    (q[0] === "why" && response[0] === "because") ||
    (q[0] === "where" &&
      /^(at|in|inside|near|outside|by|behind|under)$/.test(response[0])) ||
    (q[0] === "when" && /^(at|after|before|around|when)$/.test(response[0])) ||
    (/^(which|what)$/.test(q[0]) && q.includes("or") && a.length <= 5)
  );
}

export function questionEnding(
  segments: Cue[],
  start: number,
  end: number,
  available: number,
  maxClip: number,
  words?: TimedWord[],
) {
  const index = segments.findLastIndex(
    (s) => s.startMs < end && s.endMs > start,
  );
  const question = segments[index];
  if (
    !question ||
    !/\?["'”’]*$/.test(question.text.trim()) ||
    question.endMs > end ||
    end - question.endMs > 1600
  )
    return;
  const limit = Math.min(available, start + maxClip);
  const reliable = (cue: Cue) =>
    !words?.some(
      (w) =>
        w.startMs < cue.endMs && w.endMs > cue.startMs && w.probability < 0.7,
    );
  for (let i = index + 1; i < Math.min(segments.length, index + 4); i++) {
    const reply = segments[i];
    if (
      reply.startMs < question.endMs ||
      reply.startMs - question.endMs > 5000 ||
      reply.endMs <= reply.startMs ||
      reply.endMs > Math.min(limit, end + 9000)
    )
      break;
    if (/^(?:uh|um|hmm|erm)[.!,…\s]*$/i.test(reply.text.trim())) continue;
    if (
      directReply(question.text, reply.text) &&
      reliable(question) &&
      reliable(reply)
    ) {
      const gap = Math.max(
        0,
        Math.min(limit, segments[i + 1]?.startMs ?? limit) - reply.endMs,
      );
      const pauseMs = Math.min(450, Math.floor(gap / 2));
      return { question, reply, pauseMs, end: reply.endMs + pauseMs };
    }
    break; // A topic change or another question ends the exchange.
  }
  return { question, reply: null, pauseMs: 0, end };
}
