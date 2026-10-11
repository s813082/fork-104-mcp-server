/**
 * 使用者求職背景與評分規則的本機儲存。
 *
 * 這裡只提供通用 schema、檔案路徑與讀寫，不內建任何人的資料或偏好。
 * profile.json / rubric.json 永遠落在使用者本機，不會寫進專案目錄。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const finiteNumber = z.number().finite();
const nonNegativeNumber = finiteNumber.nonnegative();

export const levelSchema = z.enum(["A", "B", "C", "D"]);

const profileSkillSchema = z.object({
  name: z.string().trim().min(1),
  aliases: z.array(z.string().trim().min(1)).optional(),
  claimedLevel: levelSchema,
  evidence: z.string().optional(),
  // effectiveLevel 是儲存時依 evidencePolicy 推導的欄位，不接受它取代 claimedLevel。
  effectiveLevel: levelSchema.optional(),
});

export const profileSchema = z.object({
  version: z.literal(1),
  basic: z.object({
    title: z.string().trim().min(1),
    yearsExperience: nonNegativeNumber,
    locations: z.array(z.string().trim().min(1)),
  }),
  skills: z.array(profileSkillSchema),
  salary: z.object({
    current: nonNegativeNumber.optional(),
    floor: nonNegativeNumber,
    expectedMin: nonNegativeNumber.optional(),
    expectedMax: nonNegativeNumber.optional(),
  }),
  dealBreakers: z.object({
    industries: z.array(z.string().trim().min(1)).optional(),
    education: z.array(z.string().trim().min(1)).optional(),
    keywords: z.array(z.string().trim().min(1)).optional(),
    travel: z.boolean().optional(),
    languages: z.array(z.string().trim().min(1)).optional(),
  }),
  preferences: z.object({
    industries: z.array(z.string().trim().min(1)).optional(),
    companyTypes: z.array(z.string().trim().min(1)).optional(),
    roleTypes: z.array(z.string().trim().min(1)).optional(),
  }),
  growth: z.object({
    direction: z.string().trim().optional(),
    comfortRatio: finiteNumber.optional(),
    challengeRatio: finiteNumber.optional(),
    challengeGapTolerance: finiteNumber.optional(),
  }),
  learning: z.object({
    willingness: z.string().trim().optional(),
    hoursPerWeek: nonNegativeNumber.optional(),
  }),
  excludeKeywords: z.array(z.string().trim().min(1)).optional(),
});

const dimensionCommon = {
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  weight: finiteNumber.positive(),
  source: z.string().trim().min(1),
};

const skillMatchDimensionSchema = z.object({
  ...dimensionCommon,
  type: z.literal("skillMatch"),
  params: z.object({
    terms: z.array(
      z.object({
        term: z.string().trim().min(1),
        aliases: z.array(z.string().trim().min(1)).optional(),
        userLevel: levelSchema,
      }),
    ),
  }),
});

const keywordDomainDimensionSchema = z.object({
  ...dimensionCommon,
  type: z.literal("keywordDomain"),
  params: z.object({
    keywords: z.array(z.string().trim().min(1)),
    fullHits: finiteNumber.positive(),
  }),
});

const numericFitDimensionSchema = z.object({
  ...dimensionCommon,
  type: z.literal("numericFit"),
  params: z.object({
    field: z.enum(["experience", "salary"]),
    userValue: finiteNumber,
    tolerance: nonNegativeNumber.optional(),
    downlevelRatio: finiteNumber.optional(),
  }),
});

const blockerDimensionSchema = z.object({
  ...dimensionCommon,
  type: z.literal("blocker"),
  params: z.object({
    terms: z.array(z.string().trim().min(1)),
    fields: z.array(z.string().trim().min(1)).optional(),
    cap: finiteNumber.min(0).max(100),
  }),
});

export const rubricDimensionSchema = z.discriminatedUnion("type", [
  skillMatchDimensionSchema,
  keywordDomainDimensionSchema,
  numericFitDimensionSchema,
  blockerDimensionSchema,
]);

export const rubricSchema = z.object({
  version: z.literal(1),
  evidencePolicy: z.object({
    downgradeWithoutEvidence: z.boolean(),
  }),
  dimensions: z.array(rubricDimensionSchema),
  bands: z.array(
    z.object({
      name: z.string().trim().min(1),
      min: finiteNumber,
    }),
  ),
});

export type Profile = z.infer<typeof profileSchema>;
export type ProfileSkill = Profile["skills"][number];
export type Rubric = z.infer<typeof rubricSchema>;
export type RubricDimension = Rubric["dimensions"][number];

const PROFILE_HOME_ENV = "JOB104_HOME";
const PROFILE_FILE = "profile.json";
const RUBRIC_FILE = "rubric.json";

/** 取得本機資料目錄；未設定時使用 ~/.config/job104-mcp。 */
export function getProfileHome(): string {
  return process.env[PROFILE_HOME_ENV]?.trim() || join(homedir(), ".config", "job104-mcp");
}

export function getProfilePath(): string {
  return join(getProfileHome(), PROFILE_FILE);
}

export function getRubricPath(): string {
  return join(getProfileHome(), RUBRIC_FILE);
}

/** 將 zod 錯誤轉成不回顯輸入內容的簡短訊息。 */
export function formatValidationError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "root";
      return `${path}: ${issue.message}`;
    })
    .join("；");
}

function readValidated<T>(filePath: string, schema: z.ZodType<T>, label: string): T | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} JSON 格式無效`);
  }

  const result = schema.safeParse(parsed);
  if (!result.success) throw new Error(`${label} schema 無效：${formatValidationError(result.error)}`);
  return result.data;
}

/** 找不到檔案回 null；格式錯誤則明確報錯，不靜默套用預設值。 */
export function loadProfile(): Profile | null {
  return readValidated(getProfilePath(), profileSchema, "profile.json");
}

/** 找不到檔案回 null；格式錯誤則明確報錯，不靜默套用預設值。 */
export function loadRubric(): Rubric | null {
  return readValidated(getRubricPath(), rubricSchema, "rubric.json");
}

export interface ProfileInitializationStatus {
  readonly status: "uninitialized" | "initialized";
  readonly createdAt?: string;
  readonly version?: 1;
  readonly missing?: readonly string[];
}

/** 僅查檔案狀態，不會建立檔案，也不會讀出個人內容。 */
export function getProfileInitializationStatus(): ProfileInitializationStatus {
  const profilePath = getProfilePath();
  const rubricPath = getRubricPath();
  const missing = [
    !existsSync(profilePath) ? PROFILE_FILE : "",
    !existsSync(rubricPath) ? RUBRIC_FILE : "",
  ].filter(Boolean);
  if (missing.length > 0) return { status: "uninitialized", missing };

  const createdTimes = [profilePath, rubricPath].map((filePath) => {
    const stat = statSync(filePath);
    return stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs;
  });
  return {
    status: "initialized",
    createdAt: new Date(Math.min(...createdTimes)).toISOString(),
    version: 1,
  };
}

function lowerLevel(level: ProfileSkill["claimedLevel"]): ProfileSkill["claimedLevel"] {
  if (level === "A") return "B";
  if (level === "B") return "C";
  if (level === "C") return "D";
  return "D";
}

function writePrivateJson(filePath: string, value: unknown): void {
  const home = getProfileHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // mkdir 的 mode 只對新目錄有效，已存在的自訂目錄也維持最小權限。
  chmodSync(home, 0o700);
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  // 已存在檔案的 mode 不會被 writeFileSync 的 mode 覆蓋，明確修正成 0600。
  chmodSync(filePath, 0o600);
}

export interface SaveProfileSummary {
  readonly profilePath: string;
  readonly rubricPath: string;
  readonly fieldCounts: Readonly<Record<string, number>>;
  readonly downgradedSkills: readonly string[];
}

function countDefinedFields(value: Record<string, unknown>): number {
  return Object.values(value).filter((item) => item !== undefined).length;
}

/** 驗證、套用 evidence policy，並以 0600 寫入兩份本機檔案。 */
export function saveProfileFiles(profileInput: unknown, rubricInput: unknown): SaveProfileSummary {
  const profileResult = profileSchema.safeParse(profileInput);
  if (!profileResult.success) throw new Error(`profile 驗證失敗：${formatValidationError(profileResult.error)}`);

  const rubricResult = rubricSchema.safeParse(rubricInput);
  if (!rubricResult.success) throw new Error(`rubric 驗證失敗：${formatValidationError(rubricResult.error)}`);

  const profile = profileResult.data;
  const rubric = rubricResult.data;
  const downgradedSkills: string[] = [];
  const savedProfile: Profile = {
    ...profile,
    skills: profile.skills.map((skill) => {
      const hasEvidence = Boolean(skill.evidence?.trim());
      const effectiveLevel = rubric.evidencePolicy.downgradeWithoutEvidence && !hasEvidence
        ? lowerLevel(skill.claimedLevel)
        : skill.claimedLevel;
      if (effectiveLevel !== skill.claimedLevel) downgradedSkills.push(skill.name);
      return { ...skill, effectiveLevel };
    }),
  };

  writePrivateJson(getProfilePath(), savedProfile);
  writePrivateJson(getRubricPath(), rubric);

  return {
    profilePath: getProfilePath(),
    rubricPath: getRubricPath(),
    fieldCounts: {
      basic: countDefinedFields(profile.basic as unknown as Record<string, unknown>),
      skills: profile.skills.length,
      salary: countDefinedFields(profile.salary as unknown as Record<string, unknown>),
      dealBreakers: countDefinedFields(profile.dealBreakers as unknown as Record<string, unknown>),
      preferences: countDefinedFields(profile.preferences as unknown as Record<string, unknown>),
      growth: countDefinedFields(profile.growth as unknown as Record<string, unknown>),
      learning: countDefinedFields(profile.learning as unknown as Record<string, unknown>),
      excludeKeywords: profile.excludeKeywords?.length ?? 0,
    },
    downgradedSkills,
  };
}
