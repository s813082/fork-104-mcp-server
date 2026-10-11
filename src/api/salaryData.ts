/**
 * 公開資料的公司薪資資料層。
 *
 * 只使用 Node 內建 fetch，第一次查詢才同時下載上市與上櫃 CSV，之後留在記憶體快取。
 * 這裡不寫檔、不記錄資料內容，也不依賴 104 的 Cloudflare 抓取 client。
 */
import { CONFIG } from "../config.js";

const CSV_HEADERS = [
  "出表日期",
  "報告年度",
  "公司代號",
  "公司名稱",
  "員工福利平均數(仟元/人)",
  "員工薪資平均數(仟元/人)",
  "非擔任主管職務之全時員工薪資平均數(仟元/人)",
  "非擔任主管職務之全時員工薪資平均數變動百分比",
  "非擔任主管之全時員工薪資中位數(仟元/人)",
  "非擔任主管職務之全時員工薪資中位數變動百分比",
  "管理職女性主管佔比",
  "新進員工年齡分布",
  "離職員工年齡分布",
  "高齡員工晉用政策及培訓計畫",
] as const;

export interface SalaryRow {
  readonly market: "listed" | "otc" | "unknown";
  readonly reportDate: string;
  readonly reportYear: string;
  readonly stockCode: string;
  readonly companyName: string;
  readonly employeeWelfareAverage: number | null;
  readonly employeeSalaryAverage: number | null;
  readonly nonManagerSalaryAverage: number | null;
  readonly nonManagerSalaryAverageYoY: string;
  readonly nonManagerSalaryMedian: number | null;
  readonly nonManagerSalaryMedianYoY: string;
  readonly femaleManagerRatio: string;
  readonly newEmployeeAgeDistribution: string;
  readonly departedEmployeeAgeDistribution: string;
  readonly seniorEmployeePolicy: string;
}

export interface SalaryCandidate {
  readonly stockCode: string;
  readonly companyName: string;
  readonly reportYear: string;
}

export interface SalaryResult {
  readonly reportYear: string;
  readonly stockCode: string;
  /** CSV 的公司名稱欄位為公開資料使用的簡稱。 */
  readonly companyName: string;
  readonly median: number | null;
  readonly average: number | null;
  readonly medianYoY: string;
  readonly unit: "仟元/人/年";
  readonly caveat: string;
}

export interface SalaryNotFound {
  readonly query: { readonly name?: string; readonly stockCode?: string };
  readonly hint: string;
}

export type SalaryLookupResult =
  | SalaryResult
  | { readonly candidates: readonly SalaryCandidate[]; readonly caveat: string }
  | { readonly notFound: SalaryNotFound };

export const SALARY_CAVEAT =
  "全職非主管全職位的年度總薪資（含年終分紅、涵蓋產線與研發），非特定職缺 offer，不可直接除以 12 當月薪。";

type CsvMarket = SalaryRow["market"];
type FetchLike = typeof fetch;

function parseCsvRecords(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;

  const pushValue = () => {
    row.push(value);
    value = "";
  };
  const pushRow = () => {
    if (row.some((cell) => cell.length > 0)) rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          value += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        value += char;
      }
      continue;
    }

    if (char === '"' && value.length === 0) {
      quoted = true;
    } else if (char === ",") {
      pushValue();
    } else if (char === "\n") {
      pushValue();
      pushRow();
    } else if (char !== "\r") {
      value += char;
    }
  }

  if (quoted) throw new Error("CSV 含有未結束的引號");
  if (value.length > 0 || row.length > 0) {
    pushValue();
    pushRow();
  }
  return rows;
}

function numberOrNull(value: string | undefined): number | null {
  const text = value?.trim() ?? "";
  if (!text) return null;
  const number = Number(text.replace(/,/g, ""));
  return Number.isFinite(number) ? number : null;
}

function indexOfHeader(headers: readonly string[], name: string): number {
  const index = headers.indexOf(name);
  if (index < 0) throw new Error(`CSV 缺少欄位「${name}」`);
  return index;
}

/** 最小 CSV parser：支援 BOM、雙引號、引號內逗號/換行、escaped quote 與空欄。 */
export function parseSalaryCsv(input: string, market: CsvMarket = "unknown"): SalaryRow[] {
  const records = parseCsvRecords(input);
  if (records.length === 0) throw new Error("CSV 沒有資料列");
  const headers = records[0];
  const indexes = Object.fromEntries(CSV_HEADERS.map((header) => [header, indexOfHeader(headers, header)]));
  const at = (row: readonly string[], header: (typeof CSV_HEADERS)[number]): string => row[indexes[header]]?.trim() ?? "";

  return records.slice(1).flatMap((row) => {
    const stockCode = at(row, "公司代號");
    if (!stockCode) return [];
    return [{
      market,
      reportDate: at(row, "出表日期"),
      reportYear: at(row, "報告年度"),
      stockCode,
      companyName: at(row, "公司名稱"),
      employeeWelfareAverage: numberOrNull(at(row, "員工福利平均數(仟元/人)")),
      employeeSalaryAverage: numberOrNull(at(row, "員工薪資平均數(仟元/人)")),
      nonManagerSalaryAverage: numberOrNull(at(row, "非擔任主管職務之全時員工薪資平均數(仟元/人)")),
      nonManagerSalaryAverageYoY: at(row, "非擔任主管職務之全時員工薪資平均數變動百分比"),
      nonManagerSalaryMedian: numberOrNull(at(row, "非擔任主管之全時員工薪資中位數(仟元/人)")),
      nonManagerSalaryMedianYoY: at(row, "非擔任主管職務之全時員工薪資中位數變動百分比"),
      femaleManagerRatio: at(row, "管理職女性主管佔比"),
      newEmployeeAgeDistribution: at(row, "新進員工年齡分布"),
      departedEmployeeAgeDistribution: at(row, "離職員工年齡分布"),
      seniorEmployeePolicy: at(row, "高齡員工晉用政策及培訓計畫"),
    }];
  });
}

let salaryRowsPromise: Promise<SalaryRow[]> | null = null;

async function fetchCsv(url: string, market: Exclude<CsvMarket, "unknown">, fetchImpl: FetchLike): Promise<SalaryRow[]> {
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { Accept: "text/csv, text/plain;q=0.9, */*;q=0.8" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${market === "listed" ? "上市" : "上櫃"}薪資 CSV 下載失敗：${message}`);
  }
  if (!response.ok) {
    throw new Error(`${market === "listed" ? "上市" : "上櫃"}薪資 CSV 下載失敗：HTTP ${response.status}`);
  }
  try {
    return parseSalaryCsv(await response.text(), market);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${market === "listed" ? "上市" : "上櫃"}薪資 CSV 解析失敗：${message}`);
  }
}

function deduplicateRows(rows: readonly SalaryRow[]): SalaryRow[] {
  const unique = new Map<string, SalaryRow>();
  for (const row of rows) unique.set(`${row.stockCode}|${row.reportYear}|${row.companyName}`, row);
  return [...unique.values()];
}

/** 供測試注入 fetch；正式呼叫使用 Node 內建 fetch。 */
export async function loadSalaryData(fetchImpl: FetchLike = globalThis.fetch): Promise<SalaryRow[]> {
  if (!salaryRowsPromise) {
    salaryRowsPromise = Promise.all([
      fetchCsv(CONFIG.salaryListedCsvUrl, "listed", fetchImpl),
      fetchCsv(CONFIG.salaryOtcCsvUrl, "otc", fetchImpl),
    ])
      .then(([listed, otc]) => deduplicateRows([...listed, ...otc]))
      .catch((err) => {
        // 失敗不能把半套資料留在快取，下次仍需同時重抓兩份。
        salaryRowsPromise = null;
        throw err;
      });
  }
  return salaryRowsPromise;
}

export function resetSalaryDataCache(): void {
  salaryRowsPromise = null;
}

function normalizeName(value: string): string {
  return value
    .replace(/股份有限公司|有限公司/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function nameMatches(csvName: string, inputName: string): boolean {
  const name = normalizeName(csvName).toLocaleLowerCase();
  const input = normalizeName(inputName).toLocaleLowerCase();
  if (!name || !input) return false;
  return name.startsWith(input) || name.includes(input) || input.includes(name);
}

function toCandidate(row: SalaryRow): SalaryCandidate {
  return { stockCode: row.stockCode, companyName: row.companyName, reportYear: row.reportYear };
}

function toSalaryResult(row: SalaryRow): SalaryResult {
  return {
    reportYear: row.reportYear,
    stockCode: row.stockCode,
    companyName: row.companyName,
    median: row.nonManagerSalaryMedian,
    average: row.nonManagerSalaryAverage,
    medianYoY: row.nonManagerSalaryMedianYoY,
    unit: "仟元/人/年",
    caveat: SALARY_CAVEAT,
  };
}

/** 依公司代號精準或公司簡稱模糊查詢公開薪資資料。 */
export async function getCompanySalary(
  query: { readonly name?: string; readonly stockCode?: string },
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<SalaryLookupResult> {
  const name = query.name?.trim() || undefined;
  const stockCode = query.stockCode?.trim() || undefined;
  if (!name && !stockCode) throw new Error("name 與 stockCode 至少提供一個");

  const rows = await loadSalaryData(fetchImpl);
  const matches = rows.filter((row) => {
    if (stockCode && row.stockCode !== stockCode) return false;
    return !name || nameMatches(row.companyName, name);
  });

  if (matches.length === 0) {
    return {
      notFound: {
        query: { name, stockCode },
        hint: "查無上市或上櫃公開資料；興櫃與未上市公司不在這份資料範圍內。",
      },
    };
  }
  if (matches.length > 1) return { candidates: matches.map(toCandidate), caveat: SALARY_CAVEAT };
  return toSalaryResult(matches[0]);
}
