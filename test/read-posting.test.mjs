import test from "node:test";
import assert from "node:assert/strict";
import { readPosting } from "../dist/tools/readPosting.js";

test("accepts pasted posting text as data", async () => {
  const result = await readPosting({ text: "Senior Engineer\nBuild secure APIs." });
  assert.equal(result.mode, "pasted_text");
  assert.equal(result.text, "Senior Engineer\nBuild secure APIs.");
  assert.equal(result.pasteFallback, false);
});

test("requires exactly one of URL and pasted text", async () => {
  await assert.rejects(() => readPosting({}), /擇一/);
  await assert.rejects(() => readPosting({ url: "https://jobs.example/a", text: "Role" }), /擇一/);
});

test("invalid or non-public URLs explain paste fallback instead of reporting zero jobs", async () => {
  const invalid = await readPosting({ url: "not a url" });
  assert.equal(invalid.pasteFallback, true);
  assert.match(invalid.warning, /請貼上職缺內容/);
  const local = await readPosting({ url: "https://127.0.0.1/private" });
  assert.equal(local.pasteFallback, true);
  assert.match(local.warning, /(IP|拒絕讀取)/);
});
