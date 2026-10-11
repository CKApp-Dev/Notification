'use strict';

// Cloud Run IAM authenticates requests before they reach this handler.
function createHandler(runWorker, logger = console) {
  return async (request, response) => {
    const reply = (status, body, headers = {}) => {
      response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
      response.end(body);
    };
    if (request.url !== '/run') return reply(404, 'Not found\n');
    if (request.method !== 'POST') return reply(405, 'Method not allowed\n', { Allow: 'POST' });
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

module.exports = { createHandler };
