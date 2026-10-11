/**
 * 職缺評分純函式引擎。
 *
 * 這裡只依輸入的 JD、profile 與 rubric 計算可重現的參考分數，
 * 不連網、不讀檔，也不內建任何人的規則或資料。
 */
import { createHash } from "node:crypto";
import type { Profile, Rubric, RubricDimension } from "./profile.js";

const LEVEL_SCORE: Record<"A" | "B" | "C" | "D", number> = { A: 1, B: 0.7, C: 0.3, D: 0 };
const SKILL_FIELDS = ["skills", "jobSkills", "description", "otherConditions"] as const;
const ALL_TEXT_FIELDS = [
  "jobName",
  "companyName",
  "salary",
  "area",
  "location",
  "description",
  "categories",
  "experience",
  "education",
  "majors",
  "otherConditions",
  "skills",
  "jobSkills",
  "languages",
  "industry",
] as const;
// 刻意不含 headcount、manageResp、businessTrip、employees、welfareTags、welfare：
// 這些是制式欄位或福利長文（例如「無需出差外派」），預設掃描會造成 blocker／領域關鍵字誤中。
// rubric 若真要比對，可在 blocker 的 params.fields 明確指定。

type ScoreJobInput = unknown;

export interface ScoreHit {
  readonly term?: string;
  readonly keyword?: string;
  readonly matchedBy?: string;
  readonly fields: readonly string[];
  readonly userLevel?: "A" | "B" | "C" | "D";
  readonly score?: number;
}

export interface ScoreDimension {
  readonly id: string;
  readonly label: string;
  readonly score: number | null;
  readonly weight: number;
  readonly hits: readonly ScoreHit[];
}

export interface ScoreBlocker {
  readonly term: string;
  readonly fields: readonly string[];
  readonly cap: number;
}

export interface ScoreFlags {
  readonly downlevel?: boolean;
  readonly salaryNegotiable?: boolean;
}

export interface ScoreResult {
  readonly totalScore: number | null;
  readonly grade: string;
  readonly status: "ok" | "insufficientData";
  readonly insufficientData: boolean;
  readonly dimensions: readonly ScoreDimension[];
  readonly gaps: readonly ScoreHit[];
  readonly blockers: readonly ScoreBlocker[];
  readonly flags: ScoreFlags;
  readonly rubricVersion: 1;
  readonly profileHash: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function toText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(toText).filter(Boolean).join(" ");
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function normalizeText(value: string): string {
  return value.toLocaleLowerCase();
}

function fieldText(job: Record<string, unknown>, field: string): string {
  return toText(job[field]);
}

function allFields(job: Record<string, unknown>, fields: readonly string[]): Record<string, string> {
  return Object.fromEntries(fields.map((field) => [field, fieldText(job, field)]));
}

function matchingFields(
  jobFields: Record<string, string>,
  terms: readonly string[],
): string[] {
  const normalizedTerms = terms.map(normalizeText).filter(Boolean);
  return Object.entries(jobFields)
    .filter(([, text]) => {
      const normalized = normalizeText(text);
      return normalizedTerms.some((term) => normalized.includes(term));
    })
    .map(([field]) => field);
}

function findTermHit(
  jobFields: Record<string, string>,
  term: string,
  aliases: readonly string[] | undefined,
  userLevel: "A" | "B" | "C" | "D",
): ScoreHit | null {
  const candidates = [term, ...(aliases ?? [])];
  const normalizedFields = Object.fromEntries(
    Object.entries(jobFields).map(([field, text]) => [field, normalizeText(text)]),
  );
  const matchedBy = candidates.find((candidate) => {
    const normalizedCandidate = normalizeText(candidate);
    return normalizedCandidate.length > 0 && Object.values(normalizedFields).some((text) => text.includes(normalizedCandidate));
  });
  if (!matchedBy) return null;
  return {
    term,
    matchedBy,
    fields: matchingFields(jobFields, candidates),
    userLevel,
    score: LEVEL_SCORE[userLevel],
  };
}

const LEVEL_ORDER = ["A", "B", "C", "D"] as const;
type Level = (typeof LEVEL_ORDER)[number];

/**
 * 技能層級以「較差者」為準：rubric 的 userLevel 與 profile 同名技能的有效層級取低。
 * 這讓 evidencePolicy 的「無佐證降級」真的影響分數，且 profile 不會把 rubric 的層級往上灌。
 */
function resolveLevel(
  profile: Profile,
  term: string,
  aliases: readonly string[] | undefined,
  rubricLevel: Level,
): Level {
  const names = new Set([term, ...(aliases ?? [])].map(normalizeText));
  const skill = profile.skills.find((candidate) =>
    [candidate.name, ...(candidate.aliases ?? [])].some((name) => names.has(normalizeText(name))),
  );
  if (!skill) return rubricLevel;
  const profileLevel = skill.effectiveLevel ?? skill.claimedLevel;
  return LEVEL_ORDER.indexOf(profileLevel) > LEVEL_ORDER.indexOf(rubricLevel) ? profileLevel : rubricLevel;
}

function numericValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const parsed = Number(value.replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function parseExperienceRequirement(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  if (/不拘|不限|無經驗|免經驗|應屆/i.test(text)) return 0;
  const match = text.match(/(\d+(?:\.\d+)?)\s*(?:年|years?)/i);
  return match ? Number(match[1]) : null;
}

interface SalaryRange {
  readonly lower: number;
  readonly upper: number;
}

function parseSalaryRange(value: string): SalaryRange | null {
  const text = value.trim();
  if (!text || /面議|議價|negotiable/i.test(text)) return null;
  // 只比對月薪；年薪、時薪、日薪不能直接拿來跟月薪底線比，視為未知
  if (/年薪|時薪|日薪/.test(text)) return null;
  const values = [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)]
    .map((match) => Number(match[0].replace(/,/g, "")))
    .filter((number) => Number.isFinite(number));
  if (values.length === 0) return null;
  if (/以下|以下薪資/.test(text)) return { lower: 0, upper: values[0] };
  if (/以上|起薪|起/.test(text)) return { lower: values[0], upper: Number.POSITIVE_INFINITY };
  if (values.length >= 2) return { lower: Math.min(values[0], values[1]), upper: Math.max(values[0], values[1]) };
  return { lower: values[0], upper: values[0] };
}

function scoreExperience(
  job: Record<string, unknown>,
  userValue: number,
  tolerance: number | undefined,
  downlevelRatio: number | undefined,
): { score: number | null; hit: ScoreHit | null; downlevel: boolean } {
  const raw = fieldText(job, "experience");
  const required = parseExperienceRequirement(raw);
  if (required === null) return { score: null, hit: null, downlevel: false };
  const isDownlevel = downlevelRatio !== undefined && required < userValue * downlevelRatio;
  if (isDownlevel) {
    return {
      score: 0.5,
      hit: { fields: ["experience"], matchedBy: raw, score: 0.5 },
      downlevel: true,
    };
  }
  if (required <= userValue) {
    return { score: 1, hit: { fields: ["experience"], matchedBy: raw, score: 1 }, downlevel: false };
  }
  const allowed = userValue + (tolerance ?? 0);
  if (required > allowed) {
    return { score: 0, hit: { fields: ["experience"], matchedBy: raw, score: 0 }, downlevel: false };
  }
  const span = tolerance ?? 0;
  const score = span > 0 ? Math.max(0, Math.min(1, (allowed - required) / span)) : 0;
  return { score, hit: { fields: ["experience"], matchedBy: raw, score }, downlevel: false };
}

function scoreSalary(
  job: Record<string, unknown>,
  userValue: number,
): { score: number | null; hit: ScoreHit | null; negotiable: boolean } {
  const raw = fieldText(job, "salary");
  const range = parseSalaryRange(raw);
  if (!range) {
    return {
      score: null,
      hit: { fields: ["salary"], matchedBy: raw },
      negotiable: true,
    };
  }
  if (range.upper < userValue) {
    return { score: 0, hit: { fields: ["salary"], matchedBy: raw, score: 0 }, negotiable: false };
  }
  if (range.lower >= userValue) {
    return { score: 1, hit: { fields: ["salary"], matchedBy: raw, score: 1 }, negotiable: false };
  }
  if (!Number.isFinite(range.upper)) {
    const score = userValue > 0 ? Math.max(0, Math.min(1, range.lower / userValue)) : 0;
    return { score, hit: { fields: ["salary"], matchedBy: raw, score }, negotiable: false };
  }
  const score = (range.upper - userValue) / (range.upper - range.lower);
  return { score, hit: { fields: ["salary"], matchedBy: raw, score }, negotiable: false };
}

function dimensionResult(
  dimension: RubricDimension,
  profile: Profile,
  job: Record<string, unknown>,
  gaps: ScoreHit[],
  flags: { downlevel?: boolean; salaryNegotiable?: boolean },
): ScoreDimension {
  const { id, label, weight } = dimension;
  if (dimension.type === "skillMatch") {
    const jobFields = allFields(job, SKILL_FIELDS);
    const hits = dimension.params.terms
      .map((term) =>
        findTermHit(jobFields, term.term, term.aliases, resolveLevel(profile, term.term, term.aliases, term.userLevel)),
      )
      .filter((hit): hit is ScoreHit => hit !== null);
    for (const hit of hits) {
      if (hit.userLevel === "C" || hit.userLevel === "D") gaps.push(hit);
    }
    if (hits.length === 0) return { id, label, score: null, weight, hits };
    const score = hits.reduce((sum, hit) => sum + (hit.score ?? 0), 0) / hits.length;
    return { id, label, score, weight, hits };
  }

  if (dimension.type === "keywordDomain") {
    const jobFields = allFields(job, ALL_TEXT_FIELDS);
    const hits = dimension.params.keywords
      .map((keyword): ScoreHit | null => {
        const fields = matchingFields(jobFields, [keyword]);
        return fields.length > 0 ? { keyword, fields } : null;
      })
      .filter((hit): hit is ScoreHit => hit !== null);
    const score = Math.min(1, hits.length / dimension.params.fullHits);
    return { id, label, score, weight, hits };
  }

  if (dimension.type === "numericFit") {
    if (dimension.params.field === "experience") {
      const result = scoreExperience(
        job,
        dimension.params.userValue,
        dimension.params.tolerance,
        dimension.params.downlevelRatio,
      );
      if (result.downlevel) flags.downlevel = true;
      return { id, label, score: result.score, weight, hits: result.hit ? [result.hit] : [] };
    }
    const result = scoreSalary(job, dimension.params.userValue);
    if (result.negotiable) flags.salaryNegotiable = true;
    return { id, label, score: result.score, weight, hits: result.hit ? [result.hit] : [] };
  }

  // blocker 是上限約束，不作為加權分母中的一般維度。
  return { id, label, score: null, weight, hits: [] };
}

function blockerMatches(
  dimension: Extract<RubricDimension, { type: "blocker" }>,
  job: Record<string, unknown>,
): ScoreBlocker[] {
  const fields = dimension.params.fields?.length ? dimension.params.fields : ALL_TEXT_FIELDS;
  const jobFields = allFields(job, fields);
  return dimension.params.terms.flatMap((term) => {
    const matchedFields = matchingFields(jobFields, [term]);
    return matchedFields.length > 0 ? [{ term, fields: matchedFields, cap: dimension.params.cap }] : [];
  });
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

export function hashProfile(profile: Profile): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(profile)))
    .digest("hex")
    .slice(0, 12);
}

function gradeForScore(score: number, rubric: Rubric): string {
  const band = [...rubric.bands]
    .sort((a, b) => b.min - a.min)
    .find((candidate) => score >= candidate.min);
  return band?.name ?? "未達標";
}

/** 以 JD、profile、rubric 計算可重現的參考分數。 */
export function scoreJob(jobInput: ScoreJobInput, profile: Profile, rubric: Rubric): ScoreResult {
  const job = asRecord(jobInput);
  const gaps: ScoreHit[] = [];
  const blockers: ScoreBlocker[] = [];
  const flags: { downlevel?: boolean; salaryNegotiable?: boolean } = {};
  const dimensions = rubric.dimensions.map((dimension) => {
    const result = dimensionResult(dimension, profile, job, gaps, flags);
    if (dimension.type === "blocker") blockers.push(...blockerMatches(dimension, job));
    return result;
  });

  const knownDimensions = dimensions.filter((dimension) => dimension.score !== null);
  if (knownDimensions.length === 0) {
    return {
      totalScore: null,
      grade: "insufficientData",
      status: "insufficientData",
      insufficientData: true,
      dimensions,
      gaps,
      blockers,
      flags,
      rubricVersion: rubric.version,
      profileHash: hashProfile(profile),
    };
  }

  const totalWeight = knownDimensions.reduce((sum, dimension) => sum + dimension.weight, 0);
  const weighted = knownDimensions.reduce((sum, dimension) => sum + dimension.weight * (dimension.score ?? 0), 0);
  const uncappedScore = (weighted / totalWeight) * 100;
  const cap = blockers.length > 0 ? Math.min(...blockers.map((blocker) => blocker.cap)) : 100;
  const totalScore = Math.min(uncappedScore, cap);

  return {
    totalScore,
    grade: gradeForScore(totalScore, rubric),
    status: "ok",
    insufficientData: false,
    dimensions,
    gaps,
    blockers,
    flags,
    rubricVersion: rubric.version,
    profileHash: hashProfile(profile),
  };
}
