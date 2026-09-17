/**
 * 统一 HTTP 取数与限流。
 *
 * 为什么自己写而不用 p-limit / bottleneck：
 *  - 限流必须**按 host 与按 provider 分桶**，通用库只解决并发不解决配额
 *  - 学术源有硬性速率要求（arXiv 官方要求单连接 1 请求 / 3 秒），违反会被封 IP
 *  - 退避要与 AetherFlow 的 `withRetry` 语义一致，避免两套重试逻辑互相放大
 */

/** 极简令牌桶：capacity 为突发上限，refillMs 为补一个令牌的间隔。 */
export class TokenBucket {
  private tokens: number;
  private last = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly refillMs: number,
  ) {
    this.tokens = capacity;
  }

  /** 阻塞直到取到一个令牌。signal 中断时立即返回 false。 */
  async take(signal?: AbortSignal): Promise<boolean> {
    for (;;) {
      if (signal?.aborted) return false;
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return true;
      }
      const waitMs = Math.max(16, this.refillMs);
      await sleep(Math.min(waitMs, 1_000), signal);
    }
  }

  private refill(): void {
    const now = Date.now();
    const gained = Math.floor((now - this.last) / this.refillMs);
    if (gained > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + gained);
      this.last = now;
    }
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      done();
    };
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

export interface FetchTextOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
  readonly method?: "GET" | "HEAD";
  readonly accept?: string;
}

export interface FetchTextResult {
  readonly ok: boolean;
  readonly status: number;
  readonly url: string;
  readonly body: string;
  readonly contentType: string;
  readonly etag?: string;
}

/**
 * 取文本，带超时与有限重试。
 *
 * 只对 429 / 5xx 重试：4xx（除 429）是客户端问题，重试只会浪费配额。
 * 尊重 `Retry-After`。
 */
export async function fetchText(
  url: string,
  options: FetchTextOptions = {},
): Promise<FetchTextResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const method = options.method ?? "GET";
  const attempts = method === "HEAD" ? 1 : 3;

  let lastStatus = 0;
  let lastBody = "";

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (options.signal?.aborted) break;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = (): void => controller.abort();
    options.signal?.addEventListener?.("abort", onAbort, { once: true });

    try {
      const response = await fetch(url, {
        method,
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "user-agent": USER_AGENT,
          accept: options.accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          ...(options.headers ?? {}),
        },
      });

      const body = method === "HEAD" ? "" : await response.text();
      lastStatus = response.status;
      lastBody = body;

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < attempts - 1) {
        const retryAfter = Number(response.headers.get("retry-after") ?? "0");
        const waitMs = retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
        await sleep(waitMs, options.signal);
        continue;
      }

      return {
        ok: response.ok,
        status: response.status,
        url: response.url || url,
        body,
        contentType: response.headers.get("content-type") ?? "",
        ...(response.headers.get("etag") ? { etag: response.headers.get("etag") as string } : {}),
      };
    } catch {
      lastStatus = 0;
      if (attempt < attempts - 1) await sleep(400 * 2 ** attempt, options.signal);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener?.("abort", onAbort);
    }
  }

  return {
    ok: false,
    status: lastStatus,
    url,
    body: lastBody,
    contentType: "",
  };
}

/** HTTP 失败。带上状态码，让调用方区分"被限流"与"确实没有"。 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * 取 JSON。
 *
 * 免费学术 API 被限流是常态（OpenAlex 对共享出口 IP 尤其敏感），
 * 所以必须复用 fetchText 的 429/5xx 重试与 Retry-After 尊重逻辑，
 * 而不是各家自己裸 fetch —— 后者会让一次瞬时限流直接变成"这个源不可用"。
 */
export async function fetchJson<T>(url: string, options: FetchTextOptions = {}): Promise<T> {
  const result = await fetchText(url, {
    ...options,
    accept: options.accept ?? "application/json",
    timeoutMs: options.timeoutMs ?? 15_000,
  });

  if (!result.ok) {
    throw new HttpError(
      result.status,
      `HTTP ${result.status || "network error"}`,
      result.status === 429 || result.status >= 500 || result.status === 0,
    );
  }

  try {
    return JSON.parse(result.body) as T;
  } catch {
    throw new HttpError(result.status, "响应不是合法 JSON", false);
  }
}

/**
 * 显式 UA 且带联系方式：负责任的抓取器会留联系方式，
 * 站点管理员在被爬得不爽时能找到人，而不是直接封 IP 段。
 */
export const USER_AGENT =
  "AetherResearchBot/0.1 (+https://github.com/CJX0712/aether-research; research agent; contact via repository issues)";
