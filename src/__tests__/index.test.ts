import assert from 'node:assert';
import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ComputeApplication } from '@fastly/compute-testing';
import { createMiddleware } from '@mswjs/http-middleware';
import type {
  IExportTraceServiceRequest,
  ISpan,
} from '@opentelemetry/otlp-transformer';
import express from 'express';
import { HttpResponse, http } from 'msw';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getSpanAttributes(
  span: ISpan,
): Record<string, string | number | undefined> {
  return span.attributes.reduce(
    (acc, attr) => {
      acc[attr.key] =
        attr.value.stringValue ?? attr.value.intValue ?? undefined;
      return acc;
    },
    {} as Record<string, string | number | undefined>,
  );
}

function getAllSpans(requests: IExportTraceServiceRequest[]): ISpan[] {
  return requests.flatMap(req => {
    const resourceSpan = req.resourceSpans?.[0];
    if (!resourceSpan) return [];
    return resourceSpan.scopeSpans.flatMap(ss => ss.spans ?? []);
  });
}

const COLLECTOR_URL = 'http://localhost:4318/v1/traces';

describe('Basic Routing', () => {
  const app = new ComputeApplication();
  let receivedRequests: IExportTraceServiceRequest[] = [];
  let otelServer: Server;
  let httpbinServer: Server;

  const otelHandlers = [
    http.post(COLLECTOR_URL, async ({ request }) => {
      const body = (await request.json()) as IExportTraceServiceRequest;
      receivedRequests.push(body);
      return HttpResponse.json({ partialSuccess: {} });
    }),
  ];

  const httpbinHandlers = [
    http.get('http://localhost:9000/get', () => {
      return HttpResponse.json({ success: true });
    }),
  ];

  beforeAll(async () => {
    const otelApp = express();
    const otelMiddleware = createMiddleware(...otelHandlers);
    otelApp.use(otelMiddleware);

    const httpbinApp = express();
    const httpbinMiddleware = createMiddleware(...httpbinHandlers);
    httpbinApp.use(httpbinMiddleware);

    await new Promise<void>(resolve => {
      otelServer = otelApp.listen(4318, () => resolve());
    });

    await new Promise<void>(resolve => {
      httpbinServer = httpbinApp.listen(9000, () => resolve());
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
    await new Promise<void>(resolve => {
      otelServer.close(() => resolve());
    });
    await new Promise<void>(resolve => {
      httpbinServer.close(() => resolve());
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

    await new Promise(resolve => setTimeout(resolve, 100));

    expect(receivedRequests.length).toBeGreaterThan(0);

    const allSpans = getAllSpans(receivedRequests);

    const httpSpan = allSpans.find(s => s.name === 'GET /');
    assert(httpSpan, 'httpSpan should be defined');

    expect(httpSpan.kind).toBe(2);

    const attributes = getSpanAttributes(httpSpan);

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

    await new Promise(resolve => setTimeout(resolve, 100));

    const allSpans = getAllSpans(receivedRequests);

    const errorSpan = allSpans.find(s => s.name === 'GET /error');
    assert(errorSpan, 'errorSpan should be defined');

    const attributes = getSpanAttributes(errorSpan);

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

    await new Promise(resolve => setTimeout(resolve, 100));

    const allSpans = getAllSpans(receivedRequests);

    const propagatedSpan = allSpans.find(s => s.name === 'GET /');
    assert(propagatedSpan, 'propagatedSpan should be defined');
    assert(propagatedSpan.parentSpanId, 'parentSpanId should be defined');

    const spanTraceId = Buffer.from(propagatedSpan.traceId).toString('utf-8');
    const spanParentSpanId = Buffer.from(propagatedSpan.parentSpanId).toString(
      'utf-8',
    );

    expect(spanTraceId).toBe(traceId);
    expect(spanParentSpanId).toBe(parentSpanId);
  });

  it('should create complete span hierarchy: route -> custom -> backend fetch', async () => {
    const response = await app.fetch('/trace');
    expect(response.status).toBe(200);

    await new Promise(resolve => setTimeout(resolve, 100));

    const allSpans = getAllSpans(receivedRequests);

    const routeSpan = allSpans.find(s => s.name === 'GET /trace');
    assert(routeSpan, 'routeSpan should be defined');

    const customSpan = allSpans.find(s => s.name === 'custom-operation');
    assert(customSpan, 'customSpan should be defined');
    assert(
      customSpan.parentSpanId,
      'customSpan.parentSpanId should be defined',
    );

    const backendFetchSpan = allSpans.find(s => s.name === 'Backend Fetch');
    assert(backendFetchSpan, 'backendFetchSpan should be defined');
    assert(
      backendFetchSpan.parentSpanId,
      'backendFetchSpan.parentSpanId should be defined',
    );

    const routeSpanId = Buffer.from(routeSpan.spanId).toString('hex');
    const customSpanId = Buffer.from(customSpan.spanId).toString('hex');
    const customParentId = Buffer.from(customSpan.parentSpanId).toString('hex');
    const backendParentId = Buffer.from(backendFetchSpan.parentSpanId).toString(
      'hex',
    );

    expect(customParentId).toBe(routeSpanId);
    expect(backendParentId).toBe(customSpanId);

    const routeTraceId = Buffer.from(routeSpan.traceId).toString('hex');
    const customTraceId = Buffer.from(customSpan.traceId).toString('hex');
    const backendTraceId = Buffer.from(backendFetchSpan.traceId).toString(
      'hex',
    );

    expect(customTraceId).toBe(routeTraceId);
    expect(backendTraceId).toBe(routeTraceId);
  });
});

interface DynamoDBKey {
  S?: string;
  N?: string;
}

interface DynamoDBRequest {
  TableName?: string;
  Key?: Record<string, DynamoDBKey>;
}

describe('DynamoDB Integration', () => {
  const app = new ComputeApplication();
  let receivedRequests: IExportTraceServiceRequest[] = [];
  let otelServer: Server;
  let dynamoServer: Server;

  const otelHandlers = [
    http.post(COLLECTOR_URL, async ({ request }) => {
      const body = (await request.json()) as IExportTraceServiceRequest;
      receivedRequests.push(body);
      return HttpResponse.json({ partialSuccess: {} });
    }),
  ];

  const dynamoHandlers = [
    http.post('http://localhost:8000/', async ({ request }) => {
      const body = (await request.json()) as DynamoDBRequest;

      if (body.TableName === 'users' && body.Key) {
        const userId = body.Key.id?.S;

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
    const otelApp = express();
    const otelMiddleware = createMiddleware(...otelHandlers);
    otelApp.use(otelMiddleware);

    const dynamoApp = express();
    const dynamoMiddleware = createMiddleware(...dynamoHandlers);
    dynamoApp.use(dynamoMiddleware);

    await new Promise<void>(resolve => {
      otelServer = otelApp.listen(4318, () => resolve());
    });

    await new Promise<void>(resolve => {
      dynamoServer = dynamoApp.listen(8000, () => resolve());
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
    await new Promise<void>(resolve => {
      otelServer.close(() => resolve());
    });
    await new Promise<void>(resolve => {
      dynamoServer.close(() => resolve());
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

  it('should create backend fetch spans for DynamoDB calls', async () => {
    await app.fetch('/user/user1');
    await app.fetch('/user/user999');

    await new Promise(resolve => setTimeout(resolve, 100));

    const allSpans = getAllSpans(receivedRequests);

    const backendFetchSpans = allSpans.filter(s => s.name === 'Backend Fetch');

    expect(backendFetchSpans.length).toBeGreaterThan(0);
  });
});
