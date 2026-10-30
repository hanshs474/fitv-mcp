/**
 * Everything this server needs from freeimagetovideo.ai: submit a run, read its status,
 * read the credit balance. Plain fetch against the public API, with the
 * caller's own key, so a run here is priced, queued and stored exactly like a
 * run made on the website.
 */

export const SITE_URL = 'https://freeimagetovideo.ai';

/** Overridable for testing against a local build of the site; never needed in use. */
export function baseUrl(): string {
  return process.env.FITV_BASE_URL?.replace(/\/$/, '') || SITE_URL;
}

export const credentialsHint =
  'Set FITV_API_KEY to run on your own fitv credits: create a key at https://freeimagetovideo.ai/settings/apikeys';

export class FitvError extends Error {
  constructor(
    message: string,
    readonly kind:
      | 'auth'
      | 'quota'
      | 'plan'
      | 'busy'
      | 'rejected'
      | 'validation'
      | 'server'
      | 'failed'
      | 'timeout'
      | 'network',
    readonly status?: number,
    readonly code?: string
  ) {
    super(message);
    this.name = 'FitvError';
  }
}

export type Run = {
  id: string;
  status: 'generating' | 'completed' | 'failed' | string;
  videoUrl?: string | null;
  failureCode?: string | null;
};

function apiKey(): string | undefined {
  return process.env.FITV_API_KEY?.trim() || undefined;
}

export function hasApiKey(): boolean {
  return Boolean(apiKey());
}

type FetchLike = typeof fetch;
let fetchImpl: FetchLike = (...args) => fetch(...args);

/** Tests swap the transport; nothing else should. */
export function setFetch(f: FetchLike): void {
  fetchImpl = f;
}

async function post(path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const key = apiKey();
  if (!key) throw new FitvError(`No API key set. ${credentialsHint}`, 'auth');
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl()}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        'user-agent': 'fitv-mcp/0.1.0',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new FitvError(`Could not reach freeimagetovideo.ai: ${(e as Error).message}`, 'network');
  }
  const text = await res.text();
  let json: any = undefined;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new FitvError(`freeimagetovideo.ai returned a non-JSON response (HTTP ${res.status})`, 'server', res.status);
  }
  return { status: res.status, json };
}

/** Map the submit endpoint's HTTP errors onto one error kind each. */
function raise(status: number, json: any): never {
  const message: string = json?.error || json?.message || `request failed (HTTP ${status})`;
  const code: string | undefined = json?.code;
  if (status === 401) throw new FitvError(message, 'auth', status, code);
  if (status === 402) throw new FitvError(message, 'quota', status, code);
  if (status === 403) throw new FitvError(message, 'plan', status, code);
  if (status === 409) throw new FitvError(message, 'busy', status, code);
  if (code === 'content_cooldown' || code === 'content_blocked') {
    throw new FitvError(message, 'rejected', status, code);
  }
  if (status >= 400 && status < 500) throw new FitvError(message, 'validation', status, code);
  throw new FitvError(message, 'server', status, code);
}

export async function submit(
  prompt: string,
  model: string,
  parameters: Record<string, unknown> = {}
): Promise<Run> {
  const { status, json } = await post('/api/video/ai', { prompt, model, parameters });
  if (status !== 200 || !json?.success || !json?.data?.id) raise(status, json);
  return json.data as Run;
}

export async function getStatus(id: string): Promise<Run> {
  const { status, json } = await post('/api/video/status', { videoId: id });
  if (status !== 200 || !json?.success || !json?.data) raise(status, json);
  return json.data as Run;
}

export async function credits(): Promise<{ remainingCredits: number; hasPurchasedCredits: boolean }> {
  const { status, json } = await post('/api/user/get-user-credits');
  // This endpoint answers HTTP 200 with `code: -1` for a refusal, so the status
  // code alone reads a bad key as success.
  if (status === 401 || json?.code !== 0) {
    throw new FitvError(json?.message || json?.error || `request failed (HTTP ${status})`, 'auth', status);
  }
  return json.data;
}

export async function waitFor(
  id: string,
  { timeoutMs = 15 * 60_000, intervalMs = 5_000 } = {}
): Promise<Run> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await getStatus(id);
    if (run.status === 'completed') return run;
    if (run.status === 'failed') {
      throw new FitvError(
        `Run ${id} failed${run.failureCode ? ` (${run.failureCode})` : ''}.`,
        'failed',
        undefined,
        run.failureCode ?? undefined
      );
    }
    if (Date.now() + intervalMs > deadline) {
      throw new FitvError(`Run ${id} is still generating; check it later with check_status.`, 'timeout');
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
