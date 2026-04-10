/// <reference types="@fastly/js-compute" />

import './telemetry.js';
import { allowDynamicBackends } from 'fastly:experimental';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { trace } from '@opentelemetry/api';
import {
  createErrorMiddleware,
  createMetricsMiddleware,
  createTracedRouter,
  createTracingMiddleware,
} from '../../../src/index.js';

allowDynamicBackends(true);

const tracer = trace.getTracer('my-handler');

let docClient: DynamoDBDocumentClient | null = null;

function getDynamoDBClient() {
  if (!docClient) {
    const client = new DynamoDBClient({
      region: 'eu-west-1',
      endpoint: 'http://localhost:8000',
      credentials: {
        accessKeyId: 'test',
        secretAccessKey: 'test',
      },
    });
    docClient = DynamoDBDocumentClient.from(client);
  }
  return docClient;
}

const router = createTracedRouter();

router.use(createTracingMiddleware());
router.use(createMetricsMiddleware());

router.get('/', async (_req, res) => {
  return res.send('Hello world!');
});

router.get('/health', async (_req, res) => {
  return res.send('OK');
});

router.get('/redirect', async (_req, res) => {
  return res.redirect('/');
});

router.get('/trace', async (_req, res) =>
  tracer.startActiveSpan('custom-operation', async span => {
    try {
      await fetch('http://localhost:9000/get');
      res.text('Trace sent!');
    } catch (error) {
      if (typeof error === 'string' || error instanceof Error) {
        span.recordException(error);
      } else {
        span.recordException(JSON.stringify(error));
      }
    } finally {
      span.end();
    }
  }),
);

router.get('/error', async (_req, _res) => {
  throw new Error('Test error');
});

router.get('/user/:id', async (req, res) => {
  const userId = req.params.id;
  const client = getDynamoDBClient();

  const result = await client.send(
    new GetCommand({
      TableName: 'users',
      Key: { id: userId },
    }),
  );

  if (!result.Item) {
    return res.withStatus(404).json({ error: 'User not found' });
  }

  return res.json(result.Item);
});

router.use(createErrorMiddleware());

router.listen();
