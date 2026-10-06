import { classifyError, classifyResponse, type Failure } from './classify';
import { DEADLINES, deadline } from './http';

// Cheap reachability probes (PLAN.md robustness §4). They carry no tokens: they only say whether
// the internet answers, so a failed call can be told apart as "offline" or "that service is down".

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export type ProbeResult = { ok: true } | { ok: false; failure: Failure };

const TARGETS = [
  { url: 'https://slack.com/api/api.test', json: true },
  { url: 'https://api.anthropic.com/', json: false }, // any HTTP answer counts
];

async function probeOne(fetchFn: FetchFn, target: (typeof TARGETS)[number], signal?: AbortSignal): Promise<ProbeResult> {
  try {
    const res = await fetchFn(target.url, { method: target.json ? 'GET' : 'HEAD', redirect: 'manual', signal: deadline(DEADLINES.probe, signal) });
    if (target.json) {
      const f = classifyResponse(res);
      if (f?.reason === 'captive_portal') return { ok: false, failure: f };
      const body = (await res.json().catch(() => undefined)) as { ok?: boolean } | undefined;
      if (body?.ok !== true) return { ok: false, failure: { state: 'offline', reason: 'captive_portal' } };
    } else if (res.status >= 300 && res.status < 400) {
      return { ok: false, failure: { state: 'offline', reason: 'captive_portal' } };
    }
    return { ok: true };
  } catch (err) {
    const f = classifyError(err);
    return { ok: false, failure: { state: 'offline', reason: f.reason } };
  }
}

/** Online if any target answers properly. Otherwise the most telling failure. */
export async function probeNetwork(fetchFn: FetchFn = fetch, signal?: AbortSignal): Promise<ProbeResult> {
  const results = await Promise.all(TARGETS.map((t) => probeOne(fetchFn, t, signal)));
  if (results.some((r) => r.ok)) return { ok: true };
  const portal = results.find((r) => !r.ok && r.failure.reason === 'captive_portal');
  return portal ?? results[0];
}
