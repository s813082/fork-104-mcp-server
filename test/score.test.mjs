import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scoreJob } from "../dist/score.js";
import { registerScoreJob } from "../dist/tools/scoreJob.js";

const originalHome = process.env.JOB104_HOME;
const testHome = await mkdtemp(join(tmpdir(), "job104-score-"));
process.env.JOB104_HOME = testHome;

after(async () => {
  if (originalHome === undefined) delete process.env.JOB104_HOME;
  else process.env.JOB104_HOME = originalHome;
  await rm(testHome, { recursive: true, force: true });
});

const profile = {
  version: 1,
  basic: { title: "示例方向", yearsExperience: 10, locations: ["示例地點"] },
  skills: [],
  salary: { floor: 60000 },
  dealBreakers: {},
  preferences: {},
  growth: {},
  learning: {},
};

const job = {
  jobName: "示例職缺",
  salary: "月薪 50000~80000 元",
  experience: "2年以上",
  description: "alpha domain-one domain-two",
  otherConditions: "delta blocked",
  skills: ["alpha"],
  jobSkills: ["系統設計"],
};

const bands = [{ name: "高", min: 80 }, { name: "中", min: 50 }, { name: "低", min: 0 }];

test("skillMatch 命中、gaps 與 keywordDomain", () => {
  const rubric = {
    version: 1,
    evidencePolicy: { downgradeWithoutEvidence: false },
    dimensions: [
      {
        id: "skills",
        label: "技能",
        weight: 2,
        source: "synthetic.skills",
        type: "skillMatch",
        params: {
          terms: [
            { term: "alpha", aliases: ["a-term"], userLevel: "A" },
            { term: "delta", userLevel: "C" },
          ],
        },
      },
      {
        id: "domain",
        label: "領域",
        weight: 1,
        source: "synthetic.description",
        type: "keywordDomain",
        params: { keywords: ["domain-one", "domain-two"], fullHits: 2 },
      },
    ],
    bands,
  };
  const result = scoreJob(job, profile, rubric);
  assert.equal(result.status, "ok");
  assert.equal(result.dimensions[0].score, 0.65);
  assert.equal(result.dimensions[1].score, 1);
  assert.ok(result.gaps.some((gap) => gap.term === "delta" && gap.userLevel === "C"));
  assert.equal(result.totalScore, (0.65 * 2 + 1) / 3 * 100);
  assert.equal(result.rubricVersion, 1);
  assert.equal(result.profileHash.length, 12);
});

test("numericFit experience 降級、salary 面議不納入分母並標 flags", () => {
  const rubric = {
    version: 1,
    evidencePolicy: { downgradeWithoutEvidence: false },
    dimensions: [
      {
        id: "experience",
        label: "年資",
        weight: 1,
        source: "synthetic.experience",
        type: "numericFit",
        params: { field: "experience", userValue: 10, tolerance: 1, downlevelRatio: 0.5 },
      },
      {
        id: "salary",
        label: "薪資",
        weight: 1,
        source: "synthetic.salary",
        type: "numericFit",
        params: { field: "salary", userValue: 60000 },
      },
    ],
    bands,
  };
  const result = scoreJob({ ...job, salary: "面議" }, profile, rubric);
  assert.equal(result.dimensions[0].score, 0.5);
  assert.equal(result.dimensions[1].score, null);
  assert.equal(result.flags.downlevel, true);
  assert.equal(result.flags.salaryNegotiable, true);
  assert.equal(result.totalScore, 50);
});

test("numericFit experience 超過容許範圍為 0，salary 區間採線性", () => {
  const rubric = {
    version: 1,
    evidencePolicy: { downgradeWithoutEvidence: false },
    dimensions: [
      {
        id: "experience",
        label: "年資",
        weight: 1,
        source: "synthetic.experience",
        type: "numericFit",
        params: { field: "experience", userValue: 2, tolerance: 1 },
      },
      {
        id: "salary",
        label: "薪資",
        weight: 1,
        source: "synthetic.salary",
        type: "numericFit",
        params: { field: "salary", userValue: 65000 },
      },
    ],
    bands,
  };
  const result = scoreJob({ ...job, experience: "5年以上" }, profile, rubric);
  assert.equal(result.dimensions[0].score, 0);
  assert.equal(result.dimensions[1].score, 0.5);
});

test("blocker 命中後把總分封頂並列出命中欄位", () => {
  const rubric = {
    version: 1,
    evidencePolicy: { downgradeWithoutEvidence: false },
    dimensions: [
      {
        id: "known",
        label: "已知條件",
        weight: 1,
        source: "synthetic.skills",
        type: "keywordDomain",
        params: { keywords: ["alpha"], fullHits: 1 },
      },
      {
        id: "block",
        label: "阻擋詞",
        weight: 1,
        source: "synthetic.otherConditions",
        type: "blocker",
        params: { terms: ["blocked"], fields: ["otherConditions"], cap: 30 },
      },
    ],
    bands,
  };
  const result = scoreJob(job, profile, rubric);
  assert.equal(result.totalScore, 30);
  assert.equal(result.blockers[0].term, "blocked");
  assert.deepEqual(result.blockers[0].fields, ["otherConditions"]);
});

test("所有維度未知回 insufficientData", () => {
  const rubric = {
    version: 1,
    evidencePolicy: { downgradeWithoutEvidence: false },
    dimensions: [
      {
        id: "skills",
        label: "技能",
        weight: 1,
        source: "synthetic.skills",
        type: "skillMatch",
        params: { terms: [{ term: "not-present", userLevel: "A" }] },
      },
      {
        id: "salary",
        label: "薪資",
        weight: 1,
        source: "synthetic.salary",
        type: "numericFit",
        params: { field: "salary", userValue: 60000 },
      },
    ],
    bands,
  };
  const result = scoreJob({ ...job, salary: "面議" }, profile, rubric);
  assert.equal(result.status, "insufficientData");
  assert.equal(result.insufficientData, true);
  assert.equal(result.totalScore, null);
  assert.equal(result.grade, "insufficientData");
});

test("score_job 未初始化回結構化 needsInit，不取 JD、不連網", async () => {
  let registered;
  registerScoreJob({ registerTool: (name, config, handler) => { registered = { name, config, handler }; } });
  const result = await registered.handler({ jobUrlOrId: "synthetic-id" });
  const payload = JSON.parse(result.content[0].text);
  assert.ok(payload.needsInit);
  assert.ok(payload.needsInit.missing.includes("profile.json"));
  assert.match(payload.needsInit.hint, /init_profile/);
});

test("年薪、時薪不當月薪比對，視為未知並標面議 flag", () => {
  const rubric = {
    version: 1,
    evidencePolicy: { downgradeWithoutEvidence: false },
    dimensions: [
      { id: "salary", label: "薪資", weight: 1, source: "synthetic.salary", type: "numericFit", params: { field: "salary", userValue: 60000 } },
      { id: "domain", label: "領域", weight: 1, source: "synthetic.description", type: "keywordDomain", params: { keywords: ["domain-one"], fullHits: 1 } },
    ],
    bands,
  };
  for (const salary of ["年薪 1,000,000 元", "時薪 190 元"]) {
    const result = scoreJob({ ...job, salary }, profile, rubric);
    assert.equal(result.dimensions.find((d) => d.id === "salary").score, null, salary);
    assert.equal(result.flags.salaryNegotiable, true, salary);
  }
});

test("blocker 與領域關鍵字預設不掃福利、出差等制式欄位", () => {
  const rubric = {
    version: 1,
    evidencePolicy: { downgradeWithoutEvidence: false },
    dimensions: [
      { id: "domain", label: "領域", weight: 1, source: "synthetic.description", type: "keywordDomain", params: { keywords: ["domain-one", "welfare-word"], fullHits: 2 } },
      { id: "travel", label: "出差", weight: 1, source: "synthetic.dealBreakers", type: "blocker", params: { terms: ["出差"], cap: 10 } },
    ],
    bands,
  };
  const result = scoreJob({ ...job, businessTrip: "無需出差外派", welfare: "welfare-word 福利" }, profile, rubric);
  assert.equal(result.blockers.length, 0);
  assert.equal(result.dimensions.find((d) => d.id === "domain").hits.length, 1);
  // 明確指定欄位時仍可掃描
  rubric.dimensions[1].params.fields = ["businessTrip"];
  assert.equal(scoreJob({ ...job, businessTrip: "無需出差外派" }, profile, rubric).blockers.length, 1);
});

test("profile 的 effectiveLevel 會影響 skillMatch：無佐證降級確實反映在分數，且不會往上灌", () => {
  const rubric = (userLevel) => ({
    version: 1,
    evidencePolicy: { downgradeWithoutEvidence: true },
    dimensions: [
      { id: "skills", label: "技能", weight: 1, source: "synthetic.skills", type: "skillMatch", params: { terms: [{ term: "alpha", userLevel }] } },
    ],
    bands,
  });
  const withSkill = (skill) => ({ ...profile, skills: [skill] });
  const score = (p, r) => scoreJob(job, p, r).dimensions[0].score;

  // 自評 A、無佐證 → effectiveLevel 為 B → 0.7（rubric 寫 A 也一樣）
  assert.equal(score(withSkill({ name: "alpha", claimedLevel: "A", effectiveLevel: "B" }), rubric("A")), 0.7);
  // 有佐證維持 A → 1
  assert.equal(score(withSkill({ name: "alpha", claimedLevel: "A", effectiveLevel: "A" }), rubric("A")), 1);
  // profile 層級較好，但 rubric 較差 → 取較差者，不灌水
  assert.equal(score(withSkill({ name: "alpha", claimedLevel: "A", effectiveLevel: "A" }), rubric("C")), 0.3);
  // 別名可對上 profile 技能
  assert.equal(score(withSkill({ name: "other", aliases: ["Alpha"], claimedLevel: "A", effectiveLevel: "C" }), rubric("A")), 0.3);
  // profile 沒有這個技能 → 沿用 rubric 的層級
  assert.equal(score({ ...profile, skills: [] }, rubric("B")), 0.7);
});
