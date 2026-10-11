import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getProfileInitializationStatus,
  getProfilePath,
  getRubricPath,
  loadProfile,
  loadRubric,
  saveProfileFiles,
} from "../dist/profile.js";
import { registerInitProfile } from "../dist/tools/initProfile.js";
import { registerSaveProfile } from "../dist/tools/saveProfile.js";

const originalHome = process.env.JOB104_HOME;
const testHome = await mkdtemp(join(tmpdir(), "job104-profile-"));
process.env.JOB104_HOME = testHome;

after(async () => {
  if (originalHome === undefined) delete process.env.JOB104_HOME;
  else process.env.JOB104_HOME = originalHome;
  await rm(testHome, { recursive: true, force: true });
});

const profile = {
  version: 1,
  basic: { title: "示例職涯方向", yearsExperience: 6, locations: ["示例地點"] },
  skills: [
    { name: "技能甲", aliases: ["甲別名"], claimedLevel: "A", evidence: "完成示例專案" },
    { name: "技能乙", claimedLevel: "B" },
  ],
  salary: { current: 60000, floor: 55000, expectedMin: 60000, expectedMax: 80000 },
  dealBreakers: { industries: ["排除產業"], education: [], keywords: [], travel: false, languages: [] },
  preferences: { industries: ["偏好產業"], companyTypes: [], roleTypes: [] },
  growth: { direction: "示例方向", comfortRatio: 0.5, challengeRatio: 0.5, challengeGapTolerance: 0.2 },
  learning: { willingness: "願意", hoursPerWeek: 3 },
  excludeKeywords: ["排除詞"],
};

const rubric = {
  version: 1,
  evidencePolicy: { downgradeWithoutEvidence: true },
  dimensions: [
    {
      id: "skill-dimension",
      label: "技能命中",
      weight: 1,
      source: "profile.skills",
      type: "skillMatch",
      params: { terms: [{ term: "技能甲", userLevel: "A" }] },
    },
  ],
  bands: [{ name: "高", min: 80 }, { name: "一般", min: 0 }],
};

test("init_profile 是唯讀，回傳兩種模式與完整問卷欄位", async () => {
  let registered;
  registerInitProfile({ registerTool: (name, config, handler) => { registered = { name, config, handler }; } });
  const result = await registered.handler({});
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.status, "uninitialized");
  assert.equal(payload.modes.length, 2);
  assert.ok(payload.modes.every((mode) => mode.instruction.includes("密碼") && mode.instruction.includes("身分證") && mode.instruction.includes("帳號")));
  assert.ok(payload.questionnaireSchema.some((question) => question.id === "basic.title" && question.profilePath === "basic.title" && question.required));
  assert.equal(getProfileInitializationStatus().status, "uninitialized");
});

test("save/load round trip、0600 與無佐證技能降級", () => {
  const summary = saveProfileFiles(profile, rubric);
  assert.equal(summary.downgradedSkills.length, 1);
  assert.equal(summary.downgradedSkills[0], "技能乙");
  assert.equal(loadProfile().skills[0].effectiveLevel, "A");
  assert.equal(loadProfile().skills[1].effectiveLevel, "C");
  assert.deepEqual(loadRubric().dimensions[0].source, "profile.skills");
  assert.equal(summary.fieldCounts.skills, 2);

  return Promise.all([getProfilePath(), getRubricPath()].map(async (filePath) => {
    const fileStat = await stat(filePath);
    assert.equal(fileStat.mode & 0o777, 0o600);
  }));
});

test("save_profile 拒收缺 source 的 rubric 維度並指出維度", async () => {
  let registered;
  registerSaveProfile({ registerTool: (name, config, handler) => { registered = { name, config, handler }; } });
  const invalidRubric = structuredClone(rubric);
  invalidRubric.dimensions[0].source = "";
  const result = await registered.handler({ profile, rubric: invalidRubric });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /skill-dimension/);
});

test("儲存摘要不回顯整份 profile JSON", async () => {
  const text = await readFile(getProfilePath(), "utf8");
  const saved = JSON.stringify(profile);
  assert.ok(text.includes("effectiveLevel"));
  assert.notEqual(saved, text);
});
