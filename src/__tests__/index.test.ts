import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ComputeApplication } from '@fastly/compute-testing';
import { createMiddleware } from '@mswjs/http-middleware';
import express from 'express';
import { HttpResponse, http } from 'msw';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const COLLECTOR_URL = 'http://localhost:4318/v1/traces';

describe('Basic Routing', () => {
  const app = new ComputeApplication();
  let receivedRequests: unknown[] = [];
  let mockServer: Server;

  const handlers = [
    http.post(COLLECTOR_URL, async ({ request }) => {
      const body = await request.json();
      receivedRequests.push(body);
      return HttpResponse.json({ partialSuccess: {} });
    }),
  ];

  beforeAll(async () => {
    const expressApp = express();
    const middleware = createMiddleware(...handlers);
    expressApp.use(middleware);

    await new Promise<void>((resolve) => {
      mockServer = expressApp.listen(4318, () => resolve());
    });

    await app.start({
      appRoot: path.resolve(__dirname, '../..'),
    });
  });

  afterAll(async () => {
    await app.shutdown();
    await new Promise<void>((resolve) => {
      mockServer.close(() => resolve());
    });
  });

  it('should return 200 for existing route', async () => {
    const response = await app.fetch('/');
    expect(response.status).toBe(200);

    const text = await response.text();
    expect(text).toBe('Hello world!');
  });

  it('should return 404 for non-existent route', async () => {
    const response = await app.fetch('/nonexistent');
    expect(response.status).toBe(404);
  });

  it('should create and export spans via auto-instrumentation', async () => {
    receivedRequests = [];

    const response = await app.fetch('/trace');
    expect(response.status).toBe(200);

    const text = await response.text();
    expect(text).toBe('Trace sent!');

    expect(receivedRequests.length).toBeGreaterThan(0);

    const spanData = receivedRequests[0] as any;
    expect(spanData).toHaveProperty('resourceSpans');
    expect(spanData.resourceSpans).toHaveLength(1);

    const scopeSpans = spanData.resourceSpans[0].scopeSpans;
    expect(scopeSpans).toHaveLength(1);

    const spans = scopeSpans[0].spans;
    console.log(spans);
    expect(spans.length).toBeGreaterThanOrEqual(1);

    const spanNames = spans.map((s: any) => s.name);
    expect(spanNames).toContain('event.respondWith');
  });
});
