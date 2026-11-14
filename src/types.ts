/// <reference types="@cloudflare/workers-types" />

/** Worker bindings and configuration. */
export interface Env {
  /** D1 database holding the call log, conversation history, and settings. */
  DB: D1Database;

  /** Long-lived key we issue to callers of the OpenAI-compatible endpoint. */
  ACCESS_KEY: string;

  /** Password gating /admin. */
  ADMIN_PASSWORD: string;

  /** QQ bot credentials from the official Agent channel. AppSecret signs the callbacks. */
  QQ_APP_ID: string;
  QQ_APP_SECRET: string;
  /**
   * `"true"` routes message sends to QQ's sandbox API host instead of production.
   *
   * A bot must be sandbox-tested before going live, and the two hosts are not
   * interchangeable: sending to the wrong one is rejected with a message that does not
   * mention the host at all.
   */
  QQ_SANDBOX?: string;
  /**
   * IANA zone used to decide where one chat "day" ends and the next begins.
   *
   * Separate from the server's clock on purpose: a user in UTC+8 should get a new conversation
   * at their own midnight. Defaults to Asia/Shanghai when unset.
   */
  QQ_SESSION_TZ?: string;

  /**
   * OpenAI-compatible provider settings.
   *
   * ALL OPTIONAL, because every one of them can also be set at runtime from the console — which is what
   * makes changing the endpoint a change without a redeploy. Precedence is environment-first for the
   * non-secret fields, because a Worker var is set through a deployment and is therefore the place an
   * operator checks first when asking "what is this running as".
   */
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_MODEL?: string;

  /**
   * Static assets binding for the Vue console.
   *
   * Optional because it only exists once `assets` is configured in wrangler.toml AND a build has been
   * produced — so the code has to tolerate its absence and say so, rather than crash.
   */
  ASSETS?: Fetcher;
}

/** One call-log row. Bodies are stored whole: the audit view exists to answer "what did
 *  it actually ask and answer", so trimming them would remove the feature. */
export interface CallLogRow {
  id: number;
  /** Milliseconds since epoch. */
  created_at: number;
  /** Where the call came from: an access key, a QQ user, or the workbench. */
  origin: 'access_key' | 'qq' | 'workbench';
  /** Free-form identifier within the origin (key label, QQ user id, admin). */
  origin_ref: string | null;
  model: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  latency_ms: number;
  status: number;
  error: string | null;
  request_body: string;
  response_body: string | null;
}

/** D1's `.first()` returns null rather than throwing when nothing matches. */
export type Nullable<T> = T | null;
