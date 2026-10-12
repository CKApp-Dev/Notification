interface TokenUser {
  getIdToken(): Promise<string>;
}

export function publicationEndpoint(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && url.hostname.endsWith('.run.app') && url.pathname === '/run'
      && !url.username && !url.password && !url.port && !url.search && !url.hash ? url.href : null;
  } catch { return null; }
}

function publicationError(code: string): Error & { code: string } {
  return Object.assign(new Error('Publication request failed.'), { code });
}

/** No startup calls, timers or retries: one bounded worker pass per explicit action. */
export function createManualPublisher(endpoint: string, send: typeof fetch = fetch) {
  const url = publicationEndpoint(endpoint);
  let inFlight: Promise<void> | null = null;
  return (user: TokenUser): Promise<void> => {
    if (inFlight) return inFlight;
    if (!url) return Promise.reject(publicationError('failed-precondition'));
    inFlight = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 245_000);
      try {
        const token = await user.getIdToken();
        const response = await send(url, {
          method: 'POST', headers: { Authorization: `Bearer ${token}` },
          credentials: 'omit', redirect: 'error', signal: controller.signal,
        });
        if (!response.ok) {
          throw publicationError(response.status === 401 || response.status === 403 ? 'permission-denied' : 'unavailable');
        }
      } catch (error) {
        if (error instanceof Error && 'code' in error) throw error;
        throw publicationError('unavailable');
      } finally { clearTimeout(timeout); }
    })().finally(() => { inFlight = null; });
    return inFlight;
  };
}
