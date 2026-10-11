import https from "node:https";
import { isIP } from "node:net";
import { resolve4 } from "node:dns/promises";
import type { IncomingHttpHeaders } from "node:http";

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const SAFE_CONTENT_TYPES = ["text/html", "application/xhtml+xml", "text/plain"];

export interface RawHttpResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

export interface SafeFetchOptions {
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly allowedContentTypes?: readonly string[];
  readonly accept?: string;
}

export interface SafeFetchDependencies {
  readonly resolve4?: (hostname: string) => Promise<string[]>;
  readonly request?: (url: URL, address: string, timeoutMs: number, maxBytes: number) => Promise<RawHttpResponse>;
}

function ipv4Number(address: string): number[] {
  return address.split(".").map(Number);
}

/** Return false for non-routable, special-purpose, or private IPv4 ranges. */
export function isPublicIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = ipv4Number(address);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 168 || (b === 0 && c === 0) || (b === 0 && c === 2) || (b === 88 && c === 99))) return false;
  if (a === 198 && ((b === 18 || b === 19) || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a === 255 && b === 255 && c === 255) return false;
  return true;
}

async function resolveAddresses(host: string, resolver: (hostname: string) => Promise<string[]>): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      resolver(host),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("網址 DNS 查詢逾時")), 5_000); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createPinnedLookup(address: string): NonNullable<https.RequestOptions["lookup"]> {
  return ((_hostname: string, options: unknown, callback?: unknown) => {
    const cb = typeof options === "function" ? options : callback;
    if (typeof cb !== "function") return;
    const all = typeof options === "object" && options !== null && "all" in options && Boolean((options as { all?: unknown }).all);
    if (all) (cb as (error: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: number }>) => void)(null, [{ address, family: 4 }]);
    else (cb as (error: NodeJS.ErrnoException | null, address: string, family: number) => void)(null, address, 4);
  }) as NonNullable<https.RequestOptions["lookup"]>;
}

function requestPinned(url: URL, address: string, timeoutMs: number, maxBytes: number, accept: string): Promise<RawHttpResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const totalTimer = setTimeout(() => req.destroy(new Error("網址讀取逾時")), timeoutMs);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      callback();
    };
    const req = https.request(
      url,
      {
        method: "GET",
        headers: { Accept: accept, "Accept-Encoding": "identity", "User-Agent": "job104-mcp/0.5" },
        timeout: timeoutMs,
        lookup: createPinnedLookup(address),
        servername: url.hostname,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (REDIRECT_STATUS.has(status)) {
          res.destroy();
          finish(() => resolve({ status, headers: res.headers, body: Buffer.alloc(0) }));
          return;
        }
        const statedLength = Number(res.headers["content-length"]);
        if (Number.isFinite(statedLength) && statedLength > maxBytes) {
          res.destroy();
          req.destroy(new Error("網址回應超過允許大小上限"));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk: Buffer | string) => {
          const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += part.length;
          if (bytes > maxBytes) {
          req.destroy(new Error("網址回應超過允許大小上限"));
            return;
          }
          chunks.push(part);
        });
        res.on("end", () => finish(() => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) })));
        res.on("error", (error) => finish(() => reject(error)));
      },
    );
    req.on("timeout", () => req.destroy(new Error("網址讀取逾時")));
    req.on("error", (error) => finish(() => reject(error)));
    req.end();
  });
}

function contentType(headers: IncomingHttpHeaders): string {
  return String(headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
}

/** Fetch exactly one public HTTPS page, validating and pinning every redirect hop. */
export async function safeFetchText(
  rawUrl: string,
  options: SafeFetchOptions = {},
  dependencies: SafeFetchDependencies = {},
): Promise<{ readonly url: string; readonly contentType: string; readonly text: string; readonly status: number }> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const allowedTypes = options.allowedContentTypes ?? SAFE_CONTENT_TYPES;
  const resolve = dependencies.resolve4 ?? ((host) => resolve4(host));
  const request = dependencies.request ?? ((url, ip, timeout, bytes) => requestPinned(url, ip, timeout, bytes, options.accept ?? "text/html,application/xhtml+xml,text/plain;q=0.9"));
  let current: URL;

  try {
    current = new URL(rawUrl);
  } catch {
    throw new Error("網址格式無效");
  }

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    if (current.protocol !== "https:" || current.username || current.password || (current.port && current.port !== "443")) {
      throw new Error("只允許不含帳密的標準連接埠 HTTPS 網址");
    }
    const host = current.hostname.toLowerCase().replace(/\.$/, "");
    if (!host || isIP(host.replace(/^\[|\]$/g, ""))) throw new Error("不接受直接指定 IP 的網址");
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
      throw new Error("只允許公開 HTTPS 網址");
    }

    const addresses = await resolveAddresses(host, resolve);
    if (addresses.length === 0 || addresses.some((address) => !isPublicIpv4(address))) {
      throw new Error("網址解析到非公開網路位址，已拒絕讀取");
    }
    const response = await request(current, addresses[0], timeoutMs, maxBytes);
    if (response.body.length > maxBytes) throw new Error("網址回應超過允許大小上限");
    if (REDIRECT_STATUS.has(response.status)) {
      const location = response.headers.location;
      if (redirect === MAX_REDIRECTS || typeof location !== "string") throw new Error("網址重新導向超過限制或缺少目的網址");
      current = new URL(location, current);
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`網址回應 HTTP ${response.status}`);
    const type = contentType(response.headers);
    if (!allowedTypes.includes(type)) throw new Error(`不支援的職缺頁內容格式：${type || "未提供"}`);
    const encoding = String(response.headers["content-encoding"] ?? "identity").toLowerCase();
    if (encoding !== "identity") throw new Error("不支援壓縮網頁回應，請貼上職缺內容");
    return { url: current.toString(), contentType: type, text: response.body.toString("utf8"), status: response.status };
  }
  throw new Error("網址重新導向超過限制");
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] !== "#") return named[entity.toLowerCase()] ?? whole;
    const hex = entity[1]?.toLowerCase() === "x";
    const value = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "";
  });
}

export function htmlToText(html: string): { readonly title: string; readonly text: string } {
  const title = decodeEntities((html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] ?? "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ").trim();
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i)?.[1] ?? html;
  const text = decodeEntities(
    body
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|svg|iframe|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br|ul|ol|header|footer|main)\s*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}
