import test from "node:test";
import assert from "node:assert/strict";
import { searchOpportunities } from "../dist/opportunities.js";
import { getAppierJobDetail, listAppierJobs } from "../dist/providers/appierGreenhouse.js";

const job = (jobId, jobName, companyName = "Acme") => ({
  jobId, jobName, companyName, companyUrl: "", area: "台北市", salary: "面議", applyRange: "", employeeCount: 0,
  skills: [], url: `https://www.104.com.tw/job/${jobId}`, appearDate: "2026/10/01", featured: false,
});

const jobDetail = (jobId, jobName, companyName = "Acme") => ({
  jobId, jobName, companyName, companyUrl: "", url: `https://www.104.com.tw/job/${jobId}`, appearDate: "2026/10/01",
  salary: "面議", area: "台北市", location: "台北市中山區", description: "Build reliable APIs.", categories: [],
  experience: "3 年以上", education: "大學", majors: [], otherConditions: "", skills: ["TypeScript"], jobSkills: [],
  languages: [], headcount: "1 人", manageResp: "", businessTrip: "無需出差", industry: "軟體", employees: "", welfareTags: [], welfare: "",
});

test("Greenhouse list requests compact summaries and normalizes Appier roles", async () => {
  const urls = [];
  const fetchText = async (url) => {
    urls.push(url);
    return {
      url, contentType: "application/json", status: 200,
      text: JSON.stringify({ jobs: [
        { id: 101, title: "Senior Software Engineer", location: { name: "Taipei, Taiwan" }, absolute_url: "https://job-boards.greenhouse.io/appier/jobs/101", updated_at: "2026-10-01T00:00:00Z" },
        { id: 102, title: "Marketing Manager", location: { name: "Tokyo" }, absolute_url: "https://job-boards.greenhouse.io/appier/jobs/102" },
      ] }),
    };
  };
  const jobs = await listAppierJobs(["Software Engineer"], "台北市", 10, fetchText);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].sourceJobId, "101");
  assert.equal(jobs[0].company, "Appier");
  assert.equal(jobs[0].salary, null);
  assert.equal(jobs[0].description, "");
  assert.equal(urls.length, 1);
  assert.equal(urls[0].includes("content=true"), false);
});

test("Greenhouse fetches one full JD and converts HTML to text", async () => {
  let requestedUrl = "";
  const detail = await getAppierJobDetail("101", async (url) => {
    requestedUrl = url;
    return {
      url, contentType: "application/json", status: 200,
      text: JSON.stringify({
        id: 101, title: "Senior Software Engineer", location: { name: "Taipei" },
        absolute_url: "https://job-boards.greenhouse.io/appier/jobs/101", content: "<p>Design &amp; build resilient APIs.</p>",
      }),
    };
  });
  assert.match(requestedUrl, /\/jobs\/101$/);
  assert.match(detail.description, /Design & build resilient APIs/);
  assert.equal(detail.url, "https://job-boards.greenhouse.io/appier/jobs/101");
});

test("combines sources, caps candidates/details, and marks near duplicates without merging", async () => {
  const result = await searchOpportunities({ keywords: ["software engineer"], maxCandidates: 4, maxDetails: 2 }, {
    search104: async ({ page }) => ({ total: 2, page, jobs: [job("a1", "Software Engineer", "Appier"), job("a2", "Data Engineer")] }),
    listAppier: async () => [
      { sourceJobId: "101", company: "Appier", title: "Senior Software Engineer", url: "https://job-boards.greenhouse.io/appier/jobs/101", locations: ["Taipei"], salary: null, updatedAt: null, description: "" },
      { sourceJobId: "102", company: "Appier", title: "Product Manager", url: "https://job-boards.greenhouse.io/appier/jobs/102", locations: [], salary: null, updatedAt: null, description: "" },
    ],
    get104Detail: async (id) => jobDetail(id, id === "a1" ? "Software Engineer" : "Data Engineer", id === "a1" ? "Appier" : "Acme"),
    getAppierDetail: async (id) => ({
      sourceJobId: id, company: "Appier", title: "Software Engineer", url: `https://job-boards.greenhouse.io/appier/jobs/${id}`,
      locations: ["Taipei"], salary: null, updatedAt: null, description: "Build software.", truncated: false,
    }),
  });
  assert.equal(result.state, "ok");
  assert.equal(result.counts.candidates, 4);
  assert.equal(result.counts.detailsRead, 2);
  assert.equal(result.counts.detailsSucceeded, 2);
  assert.equal(result.opportunities.length, 4);
  assert.equal(result.opportunities.filter((item) => item.detailStatus === "full").length, 2);
  assert.equal(result.possibleDuplicatePairs.length, 1);
  assert.ok(result.sources.jobFrog.state === "manual_only");
  assert.match(result.sources.careerOS.note, /不做自動搜尋/);
});

test("paginates 104 within the candidate budget", async () => {
  const pages = [];
  const result = await searchOpportunities({ keywords: ["engineer"], maxCandidates: 60, maxDetails: 0 }, {
    search104: async ({ page }) => {
      pages.push(page);
      return { total: 40, page, jobs: Array.from({ length: 20 }, (_, index) => job(`a${page}-${index}`, `Role ${page}-${index}`)) };
    },
    listAppier: async (_keywords, _area, limit) => Array.from({ length: limit }, (_, index) => ({
      sourceJobId: String(index + 1), company: "Appier", title: `Role ${index}`, url: `https://job-boards.greenhouse.io/appier/jobs/${index + 1}`,
      locations: [], salary: null, updatedAt: null, description: "",
    })),
  });
  assert.deepEqual(pages, [1, 2]);
  assert.equal(result.counts.candidates, 60);
  assert.equal(result.counts.detailsRead, 0);
});

test("distinguishes partial-source failure, dual failure, and successful zero results", async () => {
  const appierOne = [{ sourceJobId: "1", company: "Appier", title: "Engineer", url: "https://job-boards.greenhouse.io/appier/jobs/1", locations: [], salary: null, updatedAt: null, description: "" }];
  const partial = await searchOpportunities({ keywords: ["engineer"], maxCandidates: 4, maxDetails: 0 }, {
    search104: async () => { throw new Error("104 timeout"); },
    listAppier: async () => appierOne,
  });
  assert.equal(partial.state, "partial");
  assert.equal(partial.sources["104"].state, "failed");
  assert.equal(partial.counts.candidates, 1);

  const bothFailed = await searchOpportunities({ keywords: ["engineer"], maxCandidates: 4, maxDetails: 0 }, {
    search104: async () => { throw new Error("104 timeout"); },
    listAppier: async () => { throw new Error("Greenhouse timeout"); },
  });
  assert.equal(bothFailed.state, "failed");
  assert.match(bothFailed.message, /不代表沒有職缺/);

  const empty = await searchOpportunities({ keywords: ["engineer"], maxCandidates: 4, maxDetails: 0 }, {
    search104: async ({ page }) => ({ total: 0, page, jobs: [] }),
    listAppier: async () => [],
  });
  assert.equal(empty.state, "ok");
  assert.equal(empty.counts.candidates, 0);
  assert.equal(empty.message, undefined);
});

test("a listed posting with an empty detail is reported as unknown, not a complete JD", async () => {
  const result = await searchOpportunities({ keywords: ["engineer"], maxCandidates: 2, maxDetails: 1 }, {
    search104: async ({ page }) => ({ total: 1, page, jobs: [job("gone", "Engineer")] }),
    listAppier: async () => [],
    get104Detail: async () => {
      const detail = jobDetail("gone", "Engineer", "Acme");
      detail.description = "";
      return detail;
    },
  });
  assert.equal(result.state, "partial");
  assert.equal(result.counts.detailFailures, 1);
  assert.equal(result.opportunities[0].detailStatus, "failed");
  assert.equal(result.opportunities[0].availability, "unknown");
  assert.ok(result.opportunities[0].missingFields.includes("fullDescription"));
});
