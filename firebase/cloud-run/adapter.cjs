'use strict';

const DEFAULT_ALLOWED_ORIGIN = 'https://notification.cksc.tw';
const PREFLIGHT_HEADERS = new Set(['authorization', 'content-type']);

function createHandler(runWorker, { authorize, allowedOrigin = DEFAULT_ALLOWED_ORIGIN, logger = console } = {}) {
  if (typeof runWorker !== 'function' || typeof authorize !== 'function') {
    throw new TypeError('Worker and authorization functions are required.');
  }
  const originUrl = new URL(allowedOrigin);
  if (originUrl.protocol !== 'https:' || originUrl.origin !== allowedOrigin) {
    throw new TypeError('The publish origin must be an exact HTTPS origin.');
  }

  return async (request, response) => {
    const originAllowed = request.headers?.origin === allowedOrigin;
    const reply = (status, body, headers = {}) => {
      response.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        Vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
        ...(originAllowed ? { 'Access-Control-Allow-Origin': allowedOrigin } : {}),
        ...headers,
      });
      response.end(body);
    };
    if (request.url !== '/run') return reply(404, 'Not found\n');
    if (!originAllowed) return reply(403, 'Origin not allowed\n');
    if (request.method === 'OPTIONS') {
      if (request.headers['access-control-request-method'] !== 'POST') {
        return reply(405, 'Method not allowed\n', { Allow: 'POST, OPTIONS' });
      }
      const requestedHeaders = request.headers['access-control-request-headers'];
      if (requestedHeaders !== undefined && (typeof requestedHeaders !== 'string'
        || requestedHeaders.length > 1024
        || requestedHeaders.split(',').some(header => !PREFLIGHT_HEADERS.has(header.trim().toLowerCase())))) {
        return reply(403, 'Headers not allowed\n');
      }
      return reply(204, '', {
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '600',
      });
    }
    if (request.method !== 'POST') return reply(405, 'Method not allowed\n', { Allow: 'POST, OPTIONS' });

    let authorization;
    try {
      authorization = await authorize(request);
    } catch {
      // Authentication providers and database errors can contain credentials.
      logger.error('Announcement authorization failed.');
      return reply(503, 'Authorization unavailable\n');
    }
    if (authorization === 'unauthenticated') return reply(401, 'Authentication required\n');
    if (authorization !== 'authorized') return reply(403, 'Admin access required\n');

    try {
      await runWorker();
      reply(200, 'Worker pass completed\n');
    } catch {
      // Provider errors can contain credentials or request data. Never log them.
      logger.error('Announcement worker pass failed.');
      reply(500, 'Worker pass failed\n');
    }
  };
}

module.exports = { createHandler, DEFAULT_ALLOWED_ORIGIN };
