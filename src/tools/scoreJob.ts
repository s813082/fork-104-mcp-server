/**
 * score_job tool 的定義與註冊。
 * 只負責讀本機設定、取得 JD 與包裝純函式評分結果。
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getJobDetail } from "../api/job104.js";
import { loadProfile, loadRubric } from "../profile.js";
import { scoreJob } from "../score.js";
import { extractSlug } from "../slug.js";

function needsInitResult(): { readonly needsInit: { readonly missing: readonly string[]; readonly hint: string } } {
  return {
    needsInit: {
      missing: [],
      hint: "尚未完成本機求職背景初始化，請先呼叫 init_profile，選擇文件匯入或純問卷，再用 save_profile 儲存後重新評分。",
    },
  };
}

export function registerScoreJob(server: McpServer): void {
  server.registerTool(
    "score_job",
    {
      title: "依本機背景評估 104 職缺",
      description:
        "取得單筆 104 職缺 JD，依使用者本機 profile 與 rubric 回傳可重現的參考分數、等級、各維度命中、技能 gaps、blockers 與 flags。若尚未初始化會回 needsInit 並引導 init_profile。關鍵字比對粗略，只是可重現的參考，不保證準確；不會憑空替未初始化的使用者評分。",
      inputSchema: {
        jobUrlOrId: z
          .string()
          .min(1)
          .describe("職缺網址或代碼，例如 'https://www.104.com.tw/job/7uqyj' 或 '7uqyj'"),
      },
    },
    async ({ jobUrlOrId }) => {
      try {
        const profile = loadProfile();
        const rubric = loadRubric();
        const missing = [
          profile ? "" : "profile.json",
          rubric ? "" : "rubric.json",
        ].filter(Boolean);
        if (!profile || !rubric) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  needsInit: {
                    ...needsInitResult().needsInit,
                    missing,
                  },
                }, null, 2),
              },
            ],
          };
        }

        const slug = extractSlug(jobUrlOrId);
        const detail = await getJobDetail(slug);
        const result = scoreJob(detail, profile, rubric);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: "text", text: `評估職缺失敗：${message}` }],
        };
      }
    },
  );
}
