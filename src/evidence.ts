import type { Transcript } from "./worker.ts";
import type { reactions } from "./detector.ts";

type EvidenceRow =
  | { id: string; kind: "speech"; startMs: number; endMs: number; text: string }
  | {
      id: string;
      kind: "chat";
      startMs: number;
      eventAt: string;
      text: string;
    };
export const assessments = {
  accept: "The cited speech contains a self-contained spoken moment.",
  reject: "The cited passage offers little standalone context.",
  review: "The supplied evidence needs review.",
};
export function sameQuote(a: string, b: string) {
  const normalized = (s: string) =>
    s.trim().replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  return normalized(a) === normalized(b);
}
export function evidenceRows(
  segments: Transcript["segments"],
  audience: ReturnType<typeof reactions>,
  clipStartMs: number,
): EvidenceRow[] {
  return [
    ...segments.slice(0, 32).map((s, i) => ({
      id: "S" + (i + 1),
      kind: "speech" as const,
      startMs: s.startMs,
      endMs: s.endMs,
      text: s.text,
    })),
    ...[...audience.sample, ...audience.counterexamples].map((m, i) => ({
      id: "C" + (i + 1),
      kind: "chat" as const,
      startMs: m.mediaMs - clipStartMs,
      eventAt: m.eventAt,
      text: m.text,
    })),
  ];
}
export function traceClaims(
  opinion: {
    decision: keyof typeof assessments;
    evidence: string[];
    reason: string;
  },
  rows: EvidenceRow[],
) {
  const resolved = rows.filter((r) => opinion.evidence.includes(r.id));
  const missing = opinion.evidence.filter(
    (id) => !resolved.some((r) => r.id === id),
  );
  const issues: string[] = [];
  if (!resolved.length || missing.length)
    issues.push("Missing or unknown timestamped evidence citation");
  if (
    opinion.reason !== assessments[opinion.decision] &&
    !resolved.some(
      (r) => r.kind === "speech" && sameQuote(r.text, opinion.reason),
    )
  )
    issues.push(
      "The model's reason contains a claim outside its cited evidence",
    );
  if (
    opinion.decision === "accept" &&
    !resolved.some((r) => r.kind === "speech")
  )
    issues.push("Acceptance lacks a cited speech segment");
  return { resolved, missing, issues };
}
