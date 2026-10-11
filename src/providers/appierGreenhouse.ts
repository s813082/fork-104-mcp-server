import { safeFetchText, htmlToText } from "../postings.js";

const BOARD_TOKEN = "appier";
const API_BASE = `https://boards-api.greenhouse.io/v1/boards/${BOARD_TOKEN}`;
const MAX_DESCRIPTION_CHARS = 12_000;

export interface AppierJobSummary {
  readonly sourceJobId: string;
  readonly company: "Appier";
  readonly title: string;
  readonly url: string;
  readonly locations: readonly string[];
  readonly salary: null;
  readonly updatedAt: string | null;
  readonly description: string;
}

export interface AppierJobDetail extends AppierJobSummary {
  readonly description: string;
  readonly truncated: boolean;
}

export type TextFetcher = typeof safeFetchText;

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Appier Greenhouse 回應格式錯誤");
  return value as Record<string, unknown>;
}

async function fetchJson(url: string, fetchText: TextFetcher): Promise<Record<string, unknown>> {
  const response = await fetchText(url, {
    accept: "application/json",
    allowedContentTypes: ["application/json"],
    maxBytes: 1024 * 1024,
  });
  try {
    return asRecord(JSON.parse(response.text));
  } catch (error) {
    if (error instanceof Error && error.message.includes("Greenhouse")) throw error;
    throw new Error("Appier Greenhouse 回傳無法解析的 JSON");
  }
}

function locationName(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "object" && value !== null && "name" in value) {
    const name = (value as { name?: unknown }).name;
    return typeof name === "string" ? name.trim() : "";
  }
  return "";
}

function normalizeSummary(rawValue: unknown): AppierJobSummary | null {
  const raw = asRecord(rawValue);
  const id = raw.id;
  const title = raw.title;
  const url = raw.absolute_url;
  if (!(Number.isInteger(id) && Number(id) >= 0 || (typeof id === "string" && /^\d+$/.test(id))) || typeof title !== "string" || !title.trim() || typeof url !== "string") return null;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }
  if (parsedUrl.protocol !== "https:" || !["job-boards.greenhouse.io", "boards.greenhouse.io"].includes(parsedUrl.hostname)) return null;
  const location = locationName(raw.location);
  return {
    sourceJobId: String(id),
    company: "Appier",
    title: title.trim(),
    url: parsedUrl.toString(),
    locations: location ? [location] : [],
    salary: null,
    updatedAt: typeof raw.updated_at === "string" ? raw.updated_at : null,
    description: "",
  };
}

function matchesQuery(job: AppierJobSummary, keywords: readonly string[], area?: string): boolean {
  const query = keywords.map((item) => item.trim().toLocaleLowerCase()).filter(Boolean);
  const title = job.title.toLocaleLowerCase();
  const location = job.locations.join(" ").toLocaleLowerCase();
  const matchesKeyword = query.length === 0 || query.some((word) => title.includes(word) || location.includes(word));
  const areaName = area?.trim().toLocaleLowerCase();
  const englishArea: Record<string, readonly string[]> = {
    "台北市": ["taipei"],
    "新北市": ["new taipei"],
    "新竹市": ["hsinchu"],
    "新竹縣": ["hsinchu"],
    "台中市": ["taichung"],
    "台南市": ["tainan"],
    "高雄市": ["kaohsiung"],
  };
  const areas = areaName ? [areaName, ...(englishArea[areaName] ?? [])] : [];
  const matchesArea = areas.length === 0 || areas.some((candidate) => location.includes(candidate));
  return matchesKeyword && matchesArea;
}

/** Read only the compact public jobs list; Greenhouse content=true would download every full JD. */
export async function listAppierJobs(
  keywords: readonly string[],
  area: string | undefined,
  limit: number,
  fetchText: TextFetcher = safeFetchText,
): Promise<readonly AppierJobSummary[]> {
  const payload = await fetchJson(`${API_BASE}/jobs`, fetchText);
  if (!Array.isArray(payload.jobs)) throw new Error("Appier Greenhouse 清單缺少 jobs 欄位");
  return payload.jobs
    .map(normalizeSummary)
    .filter((job): job is AppierJobSummary => Boolean(job && matchesQuery(job, keywords, area)))
    .slice(0, Math.max(0, limit));
}

/** Fetch one Appier job by the numeric id returned in the public list. */
export async function getAppierJobDetail(
  sourceJobId: string,
  fetchText: TextFetcher = safeFetchText,
): Promise<AppierJobDetail> {
  if (!/^\d+$/.test(sourceJobId)) throw new Error("Appier 職缺代碼無效");
  const raw = await fetchJson(`${API_BASE}/jobs/${sourceJobId}`, fetchText);
  const summary = normalizeSummary(raw);
  if (!summary || summary.sourceJobId !== sourceJobId) throw new Error("Appier 職缺詳情與清單資料不一致");
  const html = typeof raw.content === "string" ? raw.content : "";
  const description = htmlToText(html).text;
  return {
    ...summary,
    description: description.slice(0, MAX_DESCRIPTION_CHARS),
    truncated: description.length > MAX_DESCRIPTION_CHARS,
  };
}
