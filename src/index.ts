/// <reference types="@fastly/js-compute" />

import { allowDynamicBackends } from 'fastly:experimental';
import { Router } from '@fastly/expressly';
import { trace } from '@opentelemetry/api';
import './telemetry.js';

allowDynamicBackends(true);

const tracer = trace.getTracer('my-handler');

export const router = new Router();

router.get('/', async (_req, res) => {
  return res.send('Hello world!');
});

router.get('/trace', async (_req, res) =>
  tracer.startActiveSpan('thing', async (span) => {
    try {
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

router.listen();
