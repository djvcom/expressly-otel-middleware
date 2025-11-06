import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ComputeApplication } from '@fastly/compute-testing';
import { createMiddleware } from '@mswjs/http-middleware';
import express from 'express';
import { HttpResponse, http } from 'msw';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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

  beforeEach(() => {
    receivedRequests = [];
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

  it('should return 500 for non-existent route (caught by error middleware)', async () => {
    const response = await app.fetch('/nonexistent');
    expect(response.status).toBe(500);
  });

  it('should create HTTP server spans with semantic conventions', async () => {
    const response = await app.fetch('/');
    expect(response.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(receivedRequests.length).toBeGreaterThan(0);

    const allSpans = receivedRequests.flatMap((req: any) =>
      req.resourceSpans[0].scopeSpans.flatMap((ss: any) => ss.spans),
    );

    const httpSpan = allSpans.find((s) => s.name === 'GET /');
    expect(httpSpan).toBeDefined();
    expect(httpSpan.kind).toBe(2);

    const attributes = httpSpan.attributes.reduce((acc: any, attr: any) => {
      acc[attr.key] = attr.value.stringValue ?? attr.value.intValue;
      return acc;
    }, {});

    expect(attributes['http.request.method']).toBe('GET');
    expect(attributes['http.response.status_code']).toBe(200);
    expect(attributes['url.path']).toBe('/');
    expect(attributes['url.scheme']).toBe('http');
    expect(attributes['server.address']).toBe('127.0.0.1');
    expect(attributes['server.port']).toBe(7676);
    expect(attributes['network.protocol.version']).toBe('1.1');
  });

  it('should handle errors and return 500', async () => {
    const response = await app.fetch('/error');
    expect(response.status).toBe(500);

    const text = await response.text();
    expect(text).toContain('Test error');
  });

  it('should create error spans with exception details', async () => {
    const response = await app.fetch('/error');
    expect(response.status).toBe(500);

    await new Promise((resolve) => setTimeout(resolve, 100));

    const allSpans = receivedRequests.flatMap((req: any) =>
      req.resourceSpans[0].scopeSpans.flatMap((ss: any) => ss.spans),
    );

    const errorSpan = allSpans.find((s) => s.name === 'GET /error');
    expect(errorSpan).toBeDefined();

    const attributes = errorSpan.attributes.reduce((acc: any, attr: any) => {
      acc[attr.key] = attr.value.stringValue ?? attr.value.intValue;
      return acc;
    }, {});

    expect(attributes['http.response.status_code']).toBe(500);
    expect(attributes['error.type']).toBe('500');
    expect(errorSpan.status.code).toBe(2);
  });

  it('should propagate trace context from incoming headers', async () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const parentSpanId = '00f067aa0ba902b7';
    const traceparent = `00-${traceId}-${parentSpanId}-01`;

    const response = await app.fetch('/', {
      headers: {
        traceparent,
      },
    });
    expect(response.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 100));

    const allSpans = receivedRequests.flatMap((req: any) =>
      req.resourceSpans[0].scopeSpans.flatMap((ss: any) => ss.spans),
    );

    const propagatedSpan = allSpans.find((s: any) => s.name === 'GET /');
    expect(propagatedSpan).toBeDefined();

    const spanTraceId = Buffer.from(propagatedSpan.traceId).toString('utf-8');
    const spanParentSpanId = Buffer.from(propagatedSpan.parentSpanId).toString(
      'utf-8',
    );

    expect(spanTraceId).toBe(traceId);
    expect(spanParentSpanId).toBe(parentSpanId);
  });
});

describe('DynamoDB Integration', () => {
  const app = new ComputeApplication();
  let receivedRequests: unknown[] = [];
  let mockServer: Server;

  const handlers = [
    http.post(COLLECTOR_URL, async ({ request }) => {
      const body = await request.json();
      receivedRequests.push(body);
      return HttpResponse.json({ partialSuccess: {} });
    }),
    http.post('http://localhost:8000/', async ({ request }) => {
      const body: any = await request.json();

      if (body.TableName === 'users' && body.Key) {
        const userId = body.Key.id.S;

        if (userId === 'user1') {
          return HttpResponse.json({
            Item: {
              id: { S: 'user1' },
              name: { S: 'Alice' },
            },
          });
        }

        return HttpResponse.json({});
      }

      return HttpResponse.json(
        { __type: 'InternalServerError', message: 'Unknown operation' },
        { status: 500 },
      );
    }),
  ];

  beforeAll(async () => {
    const expressApp = express();
    const middleware = createMiddleware(...handlers);
    expressApp.use(middleware);

    await new Promise<void>((resolve) => {
      mockServer = expressApp.listen(8000, () => resolve());
    });

    await app.start({
      appRoot: path.resolve(__dirname, '../..'),
    });
  });

  beforeEach(() => {
    receivedRequests = [];
  });

  afterAll(async () => {
    await app.shutdown();
    await new Promise<void>((resolve) => {
      mockServer.close(() => resolve());
    });
  });

  it('should fetch user from DynamoDB and return 200', async () => {
    const response = await app.fetch('/user/user1');
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toEqual({ id: 'user1', name: 'Alice' });
  });

  it('should return 404 when user not found', async () => {
    const response = await app.fetch('/user/user999');
    expect(response.status).toBe(404);

    const data = await response.json();
    expect(data).toEqual({ error: 'User not found' });
  });
});
