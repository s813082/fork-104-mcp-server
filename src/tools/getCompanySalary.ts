/**
 * get_company_salary tool 的定義與註冊。
 * 查詢上市/上櫃官方開放資料的非主管全時員工薪資統計。
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getCompanySalary } from "../api/salaryData.js";

const inputSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    stockCode: z.string().trim().min(1).optional(),
  })
  .refine((value) => Boolean(value.name || value.stockCode), {
    message: "name 與 stockCode 至少提供一個",
  });

export function registerGetCompanySalary(server: McpServer): void {
  server.registerTool(
    "get_company_salary",
    {
      title: "查詢公司公開薪資統計",
      description:
        "查詢上市與上櫃官方開放資料 CSV 的非主管全時員工薪資統計。name 可填公司簡稱或全名，stockCode 為精準公司代號；多家符合會回 candidates 請使用者確認，不猜。回傳單位是仟元/人/年，固定附 caveat：這是全職非主管全職位的年度總薪資（含年終分紅、涵蓋產線與研發），不是特定職缺 offer，不可直接除以 12 當月薪。興櫃與未上市公司沒有這份資料。",
      inputSchema,
    },
    async ({ name, stockCode }) => {
      try {
        const result = await getCompanySalary({ name, stockCode });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: "text", text: `查詢公司薪資失敗：${message}` }],
        };
      }
    },
  );
}
