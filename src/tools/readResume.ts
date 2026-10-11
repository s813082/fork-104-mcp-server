import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readResume } from "../resume.js";

export function registerReadResume(server: McpServer): void {
  server.registerTool(
    "read_resume",
    {
      title: "讀取本機履歷",
      description:
        "只讀取使用者明確指定的本機 PDF、DOCX、TXT 或 Markdown 履歷，回傳有頁碼、段落或行號的文字供目前模型比對。檔案不會建立副本、寫入日誌或上傳求職網站；抽取文字會進入目前 Codex 對話，並可能由模型推導搜尋詞送往 104/Appier。掃描 PDF 不使用外部 OCR，請改貼文字。請只讀使用者本次指定的檔案，不自行搜尋目錄。",
      inputSchema: {
        path: z.string().min(1).describe("使用者明確指定的本機履歷完整路徑"),
      },
    },
    async ({ path }) => {
      try {
        const result = await readResume(path);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : "履歷讀取失敗";
        return { isError: true, content: [{ type: "text", text: `履歷讀取失敗：${message}` }] };
      }
    },
  );
}
