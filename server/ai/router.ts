// Deterministic request classification and model routing.
//
// Classification is local and instant (no extra model call), so routing never
// adds latency. The policy is configurable in Settings and can be overridden
// per message from the composer.

import type { ComplexityLevel, RoutingDecision } from "../../shared/api";
import type { Effort, Settings } from "../../shared/schemas";

export interface Classification {
  level: ComplexityLevel;
  score: number;
  signals: string[];
}

const PLAN_WORDS =
  /\b(plan|planning|organi[sz]e|reorgani[sz]e|re-?plan|schedule|reschedule|prioriti[sz]e|rebuild|restructure|organise|planifie|planifier|organise|réorganise|réorganiser|replanifie|programme|priorise|prioriser)\b/i;
const RANGE_WORDS =
  /\b(week|weeks|weekly|month|semester|next few days|this week|next week|by (monday|tuesday|wednesday|thursday|friday|saturday|sunday)|semaine|semaines|mois|jours suivants|d'ici)\b/i;
const DISRUPTION_WORDS =
  /\b(lost|late|delay(ed)?|behind|running out|only have|exhausted|tired|sick|ill|emergency|cancel(l)?ed|unexpected|perdu|retard|en retard|fatigu[ée]e?|épuisé|épuisée|malade|imprévu|plus que)\b/i;
const RESCHEDULE_WORDS =
  /\b(move|moving|shift|postpone|push|swap|reschedule|earlier|later|priorit(y|ies|ize|ise)|urgent|important|déplace|déplacer|décale|décaler|reporte|reporter|plus tôt|plus tard|priorité|urgent)\b/i;
const BULK_WORDS = /\b(all|every|everything|unfinished|remaining|tout|toutes|tous|restant(e)?s?|inachev[ée]e?s?)\b/i;
const AMBIGUITY_WORDS = /\b(maybe|somehow|not sure|whatever|depends|peut-être|je ne sais pas|bref)\b/i;
const SIMPLE_START =
  /^\s*(add|create|new|remind me|mark|complete|done|finished|check off|rename|delete|remove|change the title|what time|when is|ajoute|ajouter|crée|créer|marque|termine|terminé|fini|renomme|supprime)\b/i;
const QUESTION_START = /^\s*(what|which|when|how much|how many|is|are|do i|should i|quel|quelle|quand|combien|est-ce|dois-je)\b/i;

/** Count the distinct actionable items in a request (comma/and-separated clauses, bullets, lines). */
function countItems(text: string): number {
  const normalized = text
    .replace(/\n\s*[-*•\d.)]+\s+/g, "\n")
    .replace(/\s+(and|et|puis|then|also|plus)\s+/gi, ",");
  return normalized
    .split(/[,;\n]+|[.!?]\s+/)
    .map((s) => s.trim())
    .filter((s) => s.split(/\s+/).length >= 2).length;
}

export function classifyRequest(message: string): Classification {
  const text = message.trim();
  const signals: string[] = [];
  let score = 0;
  const items = countItems(text);
  const times = (text.match(/\b([01]?\d|2[0-3])[:h][0-5]\d\b|\b\d{1,2}\s?(am|pm)\b/gi) ?? []).length;

  if (text.length > 450) {
    score += 2;
    signals.push("long request");
  } else if (text.length > 180) {
    score += 1;
    signals.push("detailed request");
  }
  if (items >= 6) {
    score += 3;
    signals.push(`${items} items`);
  } else if (items >= 3) {
    score += 2;
    signals.push(`${items} items`);
  }
  if (times >= 3) {
    score += 1;
    signals.push("several time constraints");
  }
  if (PLAN_WORDS.test(text)) {
    score += 2;
    signals.push("planning");
  }
  if (RANGE_WORDS.test(text)) {
    score += 2;
    signals.push("multi-day horizon");
  }
  if (DISRUPTION_WORDS.test(text)) {
    score += 2;
    signals.push("disruption");
  }
  if (RESCHEDULE_WORDS.test(text) && !PLAN_WORDS.test(text)) {
    score += 2;
    signals.push("rescheduling");
  }
  if (BULK_WORDS.test(text)) {
    score += 1;
    signals.push("bulk change");
  }
  if (AMBIGUITY_WORDS.test(text)) {
    score += 1;
    signals.push("ambiguous");
  }
  if (SIMPLE_START.test(text) && text.length < 140 && items <= 2) {
    score -= 2;
    signals.push("single action");
  } else if (QUESTION_START.test(text) && text.length < 140 && !PLAN_WORDS.test(text)) {
    score -= 1;
    signals.push("quick question");
  }
  score = Math.max(0, score);
  const level: ComplexityLevel = score <= 1 ? "simple" : score <= 4 ? "moderate" : "complex";
  return { level, score, signals };
}

export interface RouteOverride {
  model?: "auto" | "sonnet" | "opus" | "haiku";
  effort?: Effort | "auto";
}

/** Threshold above which a complex request escalates to Opus (when enabled). */
export const OPUS_ESCALATION_SCORE = 8;

export function routeRequest(message: string, settings: Settings, override: RouteOverride = {}): RoutingDecision {
  const ai = settings.ai;
  const c = classifyRequest(message);
  const effortFor = (level: ComplexityLevel): Effort =>
    level === "simple" ? ai.effortSimple : level === "moderate" ? ai.effortModerate : ai.effortComplex;

  const manualModel = override.model && override.model !== "auto" ? override.model : ai.modelMode !== "auto" ? ai.modelMode : null;
  const manualEffort = override.effort && override.effort !== "auto" ? override.effort : null;

  let family: "sonnet" | "opus" | "haiku" | "custom" = "sonnet";
  let escalated = false;
  let reason: string;
  if (manualModel === "custom" && ai.customModel) {
    family = "custom";
    reason = "Custom model selected in Settings.";
  } else if (manualModel === "opus" || manualModel === "sonnet" || manualModel === "haiku") {
    family = manualModel;
    reason = override.model && override.model !== "auto" ? "Chosen for this message." : "Fixed model selected in Settings.";
  } else if (ai.opusEscalation && c.level === "complex" && c.score >= OPUS_ESCALATION_SCORE) {
    family = "opus";
    escalated = true;
    reason = "Very complex request: escalated to Opus.";
  } else {
    reason = c.level === "simple" ? "Routine request." : c.level === "moderate" ? "Ordinary planning request." : "Complex request: stronger reasoning.";
  }

  const effort: Effort = manualEffort ?? (family === "opus" && !manualModel ? ai.opusEffort : effortFor(c.level));
  const model = family === "custom" ? ai.customModel : family;
  const modelLabel = family === "custom" ? ai.customModel : family === "opus" ? "Opus" : family === "haiku" ? "Haiku" : "Sonnet";
  return {
    level: c.level,
    score: c.score,
    signals: c.signals,
    model,
    modelLabel,
    effort,
    auto: !manualModel && !manualEffort,
    escalated,
    reason,
  };
}
