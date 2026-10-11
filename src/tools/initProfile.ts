/**
 * init_profile tool 的定義與註冊。
 * 唯讀回傳本機初始化狀態、可選模式與完整問卷 schema。
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getProfileInitializationStatus } from "../profile.js";

const PRIVACY_NOTICE = "只收求職背景與評分所需資料；不收密碼、身分證、帳號等機敏資料。";

const MODES = [
  {
    id: "import",
    label: "文件匯入",
    instruction:
      "使用者提供一般履歷或背景文件後，由 Claude 逐欄抽成 profile 草稿；每欄附來源原文，逐項請使用者確認，只有缺資料的欄位才補問。不要提供密碼、身分證、帳號等機敏資料。",
    privacyNotice: PRIVACY_NOTICE,
  },
  {
    id: "questionnaire",
    label: "純問卷",
    instruction:
      "依下方 questionnaireSchema 逐題回答，由 Claude 組成 profile 草稿並逐項確認。問卷不詢問密碼、身分證、帳號等機敏資料。",
    privacyNotice: PRIVACY_NOTICE,
  },
] as const;

const QUESTIONNAIRE_SCHEMA = [
  { id: "privacy.notice", question: "本流程不收密碼、身分證、帳號等機敏資料，請勿填寫。", profilePath: "(不儲存)", required: false },
  { id: "basic.title", question: "你希望使用的職稱或職涯標題是什麼？", profilePath: "basic.title", required: true },
  { id: "basic.yearsExperience", question: "累積工作年資是多少年？可填小數。", profilePath: "basic.yearsExperience", required: true },
  { id: "basic.locations", question: "可接受的工作地點有哪些？", profilePath: "basic.locations", required: true },
  { id: "skills", question: "有哪些技能？每項請提供自評等級 A/B/C/D 與可驗證的佐證（若有）。", profilePath: "skills", required: true },
  { id: "salary.current", question: "目前月薪是多少？不知道或不願提供可略過。", profilePath: "salary.current", required: false },
  { id: "salary.floor", question: "可接受的月薪底線是多少？單位為新台幣。", profilePath: "salary.floor", required: true },
  { id: "salary.expectedMin", question: "期望月薪下限是多少？不知道可略過。", profilePath: "salary.expectedMin", required: false },
  { id: "salary.expectedMax", question: "期望月薪上限是多少？不知道可略過。", profilePath: "salary.expectedMax", required: false },
  { id: "dealBreakers.industries", question: "哪些產業是你明確不考慮的？", profilePath: "dealBreakers.industries", required: false },
  { id: "dealBreakers.education", question: "哪些學歷要求是你明確不能接受的？", profilePath: "dealBreakers.education", required: false },
  { id: "dealBreakers.keywords", question: "哪些職缺關鍵字會讓你直接排除？", profilePath: "dealBreakers.keywords", required: false },
  { id: "dealBreakers.travel", question: "是否排斥出差或外派？", profilePath: "dealBreakers.travel", required: false },
  { id: "dealBreakers.languages", question: "哪些語言條件是你明確不能接受的？", profilePath: "dealBreakers.languages", required: false },
  { id: "preferences.industries", question: "偏好的產業有哪些？", profilePath: "preferences.industries", required: false },
  { id: "preferences.companyTypes", question: "偏好的公司類型有哪些？", profilePath: "preferences.companyTypes", required: false },
  { id: "preferences.roleTypes", question: "偏好的職務型態有哪些？", profilePath: "preferences.roleTypes", required: false },
  { id: "growth.direction", question: "下一階段希望往哪個方向成長？", profilePath: "growth.direction", required: false },
  { id: "growth.comfortRatio", question: "熟悉領域與舒適圈工作的偏好比例是多少？", profilePath: "growth.comfortRatio", required: false },
  { id: "growth.challengeRatio", question: "挑戰新領域工作的偏好比例是多少？", profilePath: "growth.challengeRatio", required: false },
  { id: "growth.challengeGapTolerance", question: "對能力落差或職務挑戰的可接受程度是多少？", profilePath: "growth.challengeGapTolerance", required: false },
  { id: "learning.willingness", question: "對學習新技能的意願如何？", profilePath: "learning.willingness", required: false },
  { id: "learning.hoursPerWeek", question: "每週可投入學習的時數是多少？", profilePath: "learning.hoursPerWeek", required: false },
  { id: "excludeKeywords", question: "還有哪些關鍵字要從候選職缺中排除？", profilePath: "excludeKeywords", required: false },
] as const;

export function registerInitProfile(server: McpServer): void {
  server.registerTool(
    "init_profile",
    {
      title: "初始化求職背景設定",
      description:
        "唯讀提供 profile.json / rubric.json 的本機初始化狀態、文件匯入或純問卷兩種流程，以及完整問卷 schema。使用者擇一後，才由 save_profile 寫入本機。只收求職背景與評分所需資料，不收密碼、身分證、帳號等機敏資料。",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ...getProfileInitializationStatus(),
                  modes: MODES,
                  questionnaireSchema: QUESTIONNAIRE_SCHEMA,
                  privacyNotice: PRIVACY_NOTICE,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: "text", text: `讀取初始化狀態失敗：${message}` }],
        };
      }
    },
  );
}
