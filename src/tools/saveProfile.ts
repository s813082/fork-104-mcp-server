/**
 * save_profile tool 的定義與註冊。
 * 驗證 profile/rubric 後只寫入使用者本機，回傳摘要，不回顯整份 profile。
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  profileSchema,
  rubricSchema,
  saveProfileFiles,
} from "../profile.js";

function missingSources(rubric: unknown): string[] {
  if (rubric === null || typeof rubric !== "object") return [];
  const dimensions = (rubric as { dimensions?: unknown }).dimensions;
  if (!Array.isArray(dimensions)) return [];
  return dimensions.flatMap((dimension, index) => {
    if (dimension === null || typeof dimension !== "object") return [`dimensions[${index}]`];
    const item = dimension as { id?: unknown; label?: unknown; source?: unknown };
    if (typeof item.source === "string" && item.source.trim()) return [];
    const name = typeof item.id === "string" && item.id.trim()
      ? item.id.trim()
      : typeof item.label === "string" && item.label.trim()
        ? item.label.trim()
        : `dimensions[${index}]`;
    return [name];
  });
}

export function registerSaveProfile(server: McpServer): void {
  server.registerTool(
    "save_profile",
    {
      title: "儲存本機求職背景與評分規則",
      description:
        "驗證 profile 與 rubric 後，將它們寫入使用者本機 JOB104_HOME（預設 ~/.config/job104-mcp）的 profile.json / rubric.json，檔案權限為 0600。rubric 每個維度都必須有非空 source；若 evidencePolicy.downgradeWithoutEvidence=true，無佐證技能會降低 effectiveLevel。回傳只有欄位數、降級清單與檔案路徑，不回顯整份 profile；不收密碼、身分證、帳號等機敏資料。",
      inputSchema: z.object({
        profile: profileSchema,
        rubric: rubricSchema,
      }),
    },
    async ({ profile, rubric }) => {
      try {
        const missing = missingSources(rubric);
        if (missing.length > 0) {
          return {
            isError: true,
            content: [{ type: "text", text: `拒絕儲存：以下 rubric 維度缺少非空 source：${missing.join("、")}` }],
          };
        }
        const summary = saveProfileFiles(profile, rubric);
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "saved", ...summary }, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: "text", text: `儲存 profile 失敗：${message}` }],
        };
      }
    },
  );
}
