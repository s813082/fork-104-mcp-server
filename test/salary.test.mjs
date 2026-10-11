import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getCompanySalary,
  parseSalaryCsv,
  resetSalaryDataCache,
} from "../dist/api/salaryData.js";

const fixturePath = fileURLToPath(new URL("./fixtures/salary-sample.csv", import.meta.url));
const fixture = await readFile(fixturePath, "utf8");
const originalFetch = globalThis.fetch;
let calls = 0;

globalThis.fetch = async () => {
  calls += 1;
  return new Response(fixture, { status: 200, headers: { "content-type": "text/csv" } });
};

after(() => {
  resetSalaryDataCache();
  globalThis.fetch = originalFetch;
});

test("CSV parser 處理 BOM、引號與空欄，並查到指定公司統計", async () => {
  const rows = parseSalaryCsv(fixture, "listed");
  assert.equal(rows.length, 5);
  assert.equal(rows[0].stockCode, "2324");
  assert.equal(rows[0].nonManagerSalaryMedian, 1418);
  assert.equal(rows[0].nonManagerSalaryAverage, 1592);
  assert.equal(rows[0].seniorEmployeePolicy, "");

  const result = await getCompanySalary({ stockCode: "2324" });
  assert.equal(result.stockCode, "2324");
  assert.equal(result.reportYear, "114");
  assert.equal(result.companyName, "仁寶");
  assert.equal(result.median, 1418);
  assert.equal(result.average, 1592);
  assert.equal(result.unit, "仟元/人/年");
  assert.match(result.caveat, /不可直接除以 12/);

  assert.equal((await getCompanySalary({ stockCode: "3231" })).median, 1197);
  assert.equal((await getCompanySalary({ stockCode: "2382" })).median, 1716);
});

test("薪資資料兩份只下載一次，名稱可去除公司後綴，且多家回 candidates", async () => {
  const byName = await getCompanySalary({ name: "仁寶電腦工業股份有限公司" });
  assert.equal(byName.stockCode, "2324");
  assert.equal(byName.median, 1418);
  assert.equal(calls, 2);

  const candidates = await getCompanySalary({ name: "農" });
  assert.ok("candidates" in candidates);
  assert.equal(candidates.candidates.length, 2);
  assert.ok(candidates.candidates.every((candidate) => candidate.reportYear === "114"));
});

test("查無資料明確說明興櫃與未上市不在範圍", async () => {
  const result = await getCompanySalary({ name: "不存在的公司" });
  assert.ok("notFound" in result);
  assert.match(result.notFound.hint, /興櫃與未上市/);
});

test("任一 CSV 下載失敗會明確報錯，不靜默使用另一份", async () => {
  resetSalaryDataCache();
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("_O_5.csv")) return new Response("", { status: 503 });
    return new Response(fixture, { status: 200 });
  };
  await assert.rejects(
    () => getCompanySalary({ stockCode: "2324" }),
    /上櫃薪資 CSV 下載失敗.*503/,
  );
  globalThis.fetch = original;
  resetSalaryDataCache();
});
