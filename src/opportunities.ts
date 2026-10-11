import { getJobDetail, searchJobs, type SearchResult } from "./api/job104.js";
import type { Job, JobDetail } from "./types.js";
import { getAppierJobDetail, listAppierJobs, type AppierJobDetail, type AppierJobSummary } from "./providers/appierGreenhouse.js";

export type OpportunitySource = "104" | "appier";
export type SourceState = "ok" | "partial" | "blocked" | "failed" | "not_searched" | "manual_only";

export interface Opportunity {
  readonly id: string;
  readonly source: OpportunitySource;
  readonly sourceJobId: string;
  readonly company: string;
  readonly title: string;
  readonly url: string;
  readonly locations: readonly string[];
  readonly salary: string | null;
  readonly fullDescription: string;
  readonly updatedAt: string | null;
  readonly fetchedAt: string;
  readonly availability: "listed" | "unknown";
  readonly detailStatus: "full" | "summary" | "failed";
  readonly descriptionTruncated: boolean;
  readonly missingFields: readonly string[];
  readonly alsoFoundAt: readonly string[];
  readonly possibleDuplicateWith: readonly string[];
}

export interface SourceReport {
  readonly state: SourceState;
  readonly candidates: number;
  readonly detailsRead: number;
  readonly note?: string;
}

export interface SearchOpportunitiesResult {
  readonly state: "ok" | "partial" | "failed";
  readonly searchedAt: string;
  readonly criteria: { readonly keywords: readonly string[]; readonly area?: string; readonly salaryMin?: number };
  readonly limits: { readonly candidates: number; readonly details: number };
  readonly sources: {
    readonly "104": SourceReport;
    readonly appier: SourceReport;
    readonly jobFrog: SourceReport;
    readonly careerOS: SourceReport;
  };
  readonly counts: { readonly candidates: number; readonly detailsRead: number; readonly detailsSucceeded: number; readonly detailFailures: number };
  readonly possibleDuplicatePairs: readonly { readonly first: string; readonly second: string; readonly reason: string }[];
  readonly opportunities: readonly Opportunity[];
  readonly message?: string;
}

export interface SearchOpportunityParams {
  readonly keywords: readonly string[];
  readonly area?: string;
  readonly salaryMin?: number;
  readonly maxCandidates?: number;
  readonly maxDetails?: number;
}

export interface OpportunityDependencies {
  readonly search104?: typeof searchJobs;
  readonly get104Detail?: typeof getJobDetail;
  readonly listAppier?: typeof listAppierJobs;
  readonly getAppierDetail?: typeof getAppierJobDetail;
}

type Candidate = {
  source: OpportunitySource;
  sourceJobId: string;
  company: string;
  title: string;
  url: string;
  locations: string[];
  salary: string | null;
  updatedAt: string | null;
  detailStatus: "summary" | "failed" | "full";
  description: string;
  descriptionTruncated: boolean;
  alsoFoundAt: string[];
  possibleDuplicateWith: string[];
};

const MAX_DESCRIPTION_CHARS = 12_000;

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function canonicalUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/$/, "");
    return url.toString();
  } catch {
    return value;
  }
}

function from104(job: Job): Candidate {
  return {
    source: "104",
    sourceJobId: job.jobId,
    company: clean(job.companyName),
    title: clean(job.jobName),
    url: job.url,
    locations: job.area ? [job.area] : [],
    salary: job.salary && job.salary !== "面議" ? job.salary : null,
    updatedAt: job.appearDate || null,
    detailStatus: "summary",
    description: "",
    descriptionTruncated: false,
    alsoFoundAt: [],
    possibleDuplicateWith: [],
  };
}

function fromAppier(job: AppierJobSummary): Candidate {
  return {
    source: "appier",
    sourceJobId: job.sourceJobId,
    company: job.company,
    title: clean(job.title),
    url: job.url,
    locations: [...job.locations],
    salary: null,
    updatedAt: job.updatedAt,
    detailStatus: "summary",
    description: "",
    descriptionTruncated: false,
    alsoFoundAt: [],
    possibleDuplicateWith: [],
  };
}

function mergeDuplicates(items: Candidate[]): Candidate[] {
  const result: Candidate[] = [];
  const byId = new Map<string, Candidate>();
  const byUrl = new Map<string, Candidate>();
  for (const item of items) {
    const prior = byId.get(`${item.source}:${item.sourceJobId}`) ?? byUrl.get(canonicalUrl(item.url));
    if (prior) {
      const ref = `${item.source}:${item.sourceJobId} ${item.url}`.trim();
      if (ref && !prior.alsoFoundAt.includes(ref)) prior.alsoFoundAt.push(ref);
      continue;
    }
    result.push(item);
    if (item.sourceJobId) byId.set(`${item.source}:${item.sourceJobId}`, item);
    if (item.url) byUrl.set(canonicalUrl(item.url), item);
  }
  return result;
}

function interleave(first: Candidate[], second: Candidate[]): Candidate[] {
  const output: Candidate[] = [];
  for (let i = 0; i < Math.max(first.length, second.length); i++) {
    if (first[i]) output.push(first[i]);
    if (second[i]) output.push(second[i]);
  }
  return output;
}

function normalizedComparable(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

function similarTitle(left: string, right: string): boolean {
  const a = normalizedComparable(left);
  const b = normalizedComparable(right);
  if (a === b) return true;
  const leftWords = new Set(left.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const rightWords = new Set(right.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  if (leftWords.size < 2 || rightWords.size < 2) return false;
  const overlap = [...leftWords].filter((word) => rightWords.has(word)).length;
  return overlap / new Set([...leftWords, ...rightWords]).size >= 0.6;
}

function markPossibleDuplicates(items: Candidate[]): Array<{ first: string; second: string; reason: string }> {
  const pairs: Array<{ first: string; second: string; reason: string }> = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const left = items[i];
      const right = items[j];
      if (left.source === right.source) continue;
      if (!similarTitle(left.title, right.title) ||
        normalizedComparable(left.company) !== normalizedComparable(right.company)) continue;
      left.possibleDuplicateWith.push(`${right.source}:${right.sourceJobId}`);
      right.possibleDuplicateWith.push(`${left.source}:${left.sourceJobId}`);
      pairs.push({ first: `${left.source}:${left.sourceJobId}`, second: `${right.source}:${right.sourceJobId}`, reason: "公司與職稱相同；保留兩個來源，請人工確認是否同一職缺。" });
    }
  }
  return pairs;
}

function format104Detail(detail: JobDetail): string {
  return [
    detail.description && `工作內容\n${detail.description}`,
    detail.experience && `工作經歷\n${detail.experience}`,
    detail.education && `學歷\n${detail.education}`,
    detail.majors.length > 0 && `科系\n${detail.majors.join("、")}`,
    detail.skills.length > 0 && `工具技能\n${detail.skills.join("、")}`,
    detail.jobSkills.length > 0 && `職務技能\n${detail.jobSkills.join("、")}`,
    detail.languages.length > 0 && `語言\n${detail.languages.join("、")}`,
    detail.otherConditions && `其他條件\n${detail.otherConditions}`,
  ].filter(Boolean).join("\n\n");
}

function apply104Detail(candidate: Candidate, detail: JobDetail): boolean {
  const text = format104Detail(detail);
  candidate.company = clean(detail.companyName) || candidate.company;
  candidate.title = clean(detail.jobName) || candidate.title;
  candidate.locations = [detail.location || detail.area].filter(Boolean);
  candidate.salary = detail.salary && detail.salary !== "面議" ? detail.salary : null;
  candidate.updatedAt = detail.appearDate || candidate.updatedAt;
  candidate.description = text.slice(0, MAX_DESCRIPTION_CHARS);
  candidate.descriptionTruncated = text.length > MAX_DESCRIPTION_CHARS;
  const hasFullDescription = Boolean(detail.description.trim());
  candidate.detailStatus = hasFullDescription ? "full" : "failed";
  return hasFullDescription;
}

function applyAppierDetail(candidate: Candidate, detail: AppierJobDetail): boolean {
  candidate.company = detail.company;
  candidate.title = clean(detail.title) || candidate.title;
  candidate.locations = [...detail.locations];
  candidate.salary = detail.salary;
  candidate.updatedAt = detail.updatedAt;
  candidate.description = detail.description.slice(0, MAX_DESCRIPTION_CHARS);
  candidate.descriptionTruncated = detail.truncated || detail.description.length > MAX_DESCRIPTION_CHARS;
  candidate.detailStatus = detail.description.trim() ? "full" : "failed";
  return Boolean(detail.description.trim());
}

function report(state: SourceState, candidates = 0, detailsRead = 0, note?: string): SourceReport {
  return { state, candidates, detailsRead, ...(note ? { note } : {}) };
}

async function collect104(
  keywords: readonly string[], area: string | undefined, salaryMin: number | undefined, budget: number,
  search: NonNullable<OpportunityDependencies["search104"]>,
): Promise<{ jobs: Candidate[]; state: SourceState; note?: string }> {
  const jobs: Candidate[] = [];
  const notes: string[] = [];
  let successful = 0;
  let failures = 0;
  const pages = Math.max(1, Math.ceil(budget / 10));
  for (let page = 1; page <= pages && jobs.length < budget; page++) {
    for (const keyword of keywords) {
      if (jobs.length >= budget) break;
      try {
        const result = await search({ keyword, area, salaryMin, page, limit: 20 });
        successful++;
        if ("jobs" in result) jobs.push(...result.jobs.slice(0, Math.max(0, budget - jobs.length)).map(from104));
        else if ("ambiguousArea" in result) notes.push(result.ambiguousArea.hint);
        else if ("companyKeyword" in result) notes.push(result.companyKeyword.hint);
      } catch (error) {
        failures++;
        notes.push(error instanceof Error ? error.message : "104 搜尋失敗");
      }
    }
  }
  const unique = mergeDuplicates(jobs).slice(0, budget);
  const state: SourceState = failures > 0
    ? (successful > 0 || unique.length > 0 ? "partial" : "failed")
    : notes.length > 0 ? "partial" : "ok";
  return { jobs: unique, state, ...(notes.length ? { note: [...new Set(notes)].join("；") } : {}) };
}

async function detailCandidate(candidate: Candidate, get104: NonNullable<OpportunityDependencies["get104Detail"]>, getAppier: NonNullable<OpportunityDependencies["getAppierDetail"]>): Promise<boolean> {
  try {
    if (candidate.source === "104") return apply104Detail(candidate, await get104(candidate.sourceJobId || candidate.url));
    return applyAppierDetail(candidate, await getAppier(candidate.sourceJobId));
  } catch {
    candidate.detailStatus = "failed";
    return false;
  }
}

async function mapWithLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  }));
}

/** Search 104 and Appier, then fetch only the bounded number of full job descriptions. */
export async function searchOpportunities(
  params: SearchOpportunityParams,
  dependencies: OpportunityDependencies = {},
): Promise<SearchOpportunitiesResult> {
  const keywords = [...new Set(params.keywords.map((word) => word.trim()).filter(Boolean))].slice(0, 3);
  if (keywords.length === 0) throw new Error("至少提供一個職務或技能關鍵字");
  const maxCandidates = Math.max(1, Math.min(params.maxCandidates ?? 60, 60));
  const maxDetails = Math.max(0, Math.min(params.maxDetails ?? 30, 30));
  const fetchBudget104 = Math.ceil(maxCandidates / 2);
  const fetchBudgetAppier = maxCandidates - fetchBudget104;
  const search104Fn = dependencies.search104 ?? searchJobs;
  const listAppierFn = dependencies.listAppier ?? listAppierJobs;
  const get104Fn = dependencies.get104Detail ?? getJobDetail;
  const getAppierFn = dependencies.getAppierDetail ?? getAppierJobDetail;

  const [result104, resultAppier] = await Promise.allSettled([
    collect104(keywords, params.area, params.salaryMin, fetchBudget104, search104Fn),
    listAppierFn(keywords, params.area, fetchBudgetAppier),
  ]);
  const source104 = result104.status === "fulfilled"
    ? result104.value
    : { jobs: [] as Candidate[], state: "failed" as SourceState, note: result104.reason instanceof Error ? result104.reason.message : "104 搜尋失敗" };
  const appierJobs = resultAppier.status === "fulfilled" ? resultAppier.value.map(fromAppier) : [];
  const sourceAppierState: SourceState = resultAppier.status === "fulfilled" ? "ok" : "failed";
  const noteAppier = resultAppier.status === "rejected"
    ? (resultAppier.reason instanceof Error ? resultAppier.reason.message : "Appier 搜尋失敗")
    : undefined;
  const allCandidates = interleave(source104.jobs, appierJobs).slice(0, maxCandidates);
  const uniqueCandidates = mergeDuplicates(allCandidates);
  const possibleDuplicatePairs = markPossibleDuplicates(uniqueCandidates);
  const selected = uniqueCandidates.slice(0, maxDetails);
  const detailResults = new Map<Candidate, boolean>();
  // Preserve 104's existing inter-request throttle; its queue is not a concurrent semaphore.
  for (const candidate of selected.filter((item) => item.source === "104")) {
    detailResults.set(candidate, await detailCandidate(candidate, get104Fn, getAppierFn));
  }
  await mapWithLimit(selected.filter((item) => item.source === "appier"), 3, async (candidate) => {
    detailResults.set(candidate, await detailCandidate(candidate, get104Fn, getAppierFn));
  });

  const detailsBySource = {
    "104": selected.filter((item) => item.source === "104").length,
    appier: selected.filter((item) => item.source === "appier").length,
  };
  const detailsSucceeded = [...detailResults.values()].filter(Boolean).length;
  const detailFailures = selected.length - detailsSucceeded;
  const source104State = detailFailures > 0 && selected.some((item) => item.source === "104" && item.detailStatus === "failed")
    ? (source104.state === "failed" ? "failed" : "partial")
    : source104.state;
  const appierState = detailFailures > 0 && selected.some((item) => item.source === "appier" && item.detailStatus === "failed")
    ? "partial"
    : sourceAppierState;
  const failures = source104State === "failed" && appierState === "failed";
  const partial = !failures && (
    source104State === "partial" || appierState === "partial" || source104State === "failed" || appierState === "failed"
  );

  const opportunities: Opportunity[] = uniqueCandidates.map((candidate) => {
    const missingFields = [
      !candidate.company && "company",
      !candidate.title && "title",
      !candidate.url && "applicationUrl",
      candidate.locations.length === 0 && "location",
      !candidate.salary && "salary",
      candidate.detailStatus !== "full" && "fullDescription",
      candidate.detailStatus === "failed" && "jobStatus",
    ].filter((field): field is string => Boolean(field));
    return {
      id: `${candidate.source}:${candidate.sourceJobId}`,
      source: candidate.source,
      sourceJobId: candidate.sourceJobId,
      company: candidate.company,
      title: candidate.title,
      url: candidate.url,
      locations: candidate.locations,
      salary: candidate.salary,
      fullDescription: candidate.description,
      updatedAt: candidate.updatedAt,
      fetchedAt: new Date().toISOString(),
      availability: candidate.detailStatus === "failed" ? "unknown" : "listed",
      detailStatus: candidate.detailStatus,
      descriptionTruncated: candidate.descriptionTruncated,
      missingFields,
      alsoFoundAt: candidate.alsoFoundAt,
      possibleDuplicateWith: candidate.possibleDuplicateWith,
    };
  });

  const appierCandidates = appierJobs.length;
  const sources = {
    "104": report(source104State, source104.jobs.length, detailsBySource["104"], source104.note),
    appier: report(appierState, appierCandidates, detailsBySource.appier, noteAppier),
    jobFrog: report("manual_only", 0, 0, "只支援讀取你提供的單筆網址或貼上的職缺文字，不做自動搜尋。"),
    careerOS: report("manual_only", 0, 0, "只支援讀取你提供的單筆網址或貼上的職缺文字，不做自動搜尋。"),
  };

  const message = failures
    ? "104 與 Appier 搜尋皆失敗；目前沒有可判斷的搜尋結果，這不代表沒有職缺。"
    : partial
      ? "部分來源或職缺詳情讀取失敗；請依來源狀態判讀，未讀到詳情的職缺不能做完整匹配。"
      : undefined;
  return {
    state: failures ? "failed" : partial ? "partial" : "ok",
    searchedAt: new Date().toISOString(),
    criteria: { keywords, ...(params.area ? { area: params.area } : {}), ...(params.salaryMin !== undefined ? { salaryMin: params.salaryMin } : {}) },
    limits: { candidates: maxCandidates, details: maxDetails },
    sources,
    counts: { candidates: uniqueCandidates.length, detailsRead: selected.length, detailsSucceeded, detailFailures },
    possibleDuplicatePairs,
    opportunities,
    ...(message ? { message } : {}),
  };
}
