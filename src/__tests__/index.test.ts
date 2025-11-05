import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ComputeApplication } from '@fastly/compute-testing';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('Basic Routing', () => {
  const app = new ComputeApplication();

  beforeAll(async () => {
    await app.start({
      appRoot: path.resolve(__dirname, '../..'),
    });
  });

  afterAll(async () => {
    await app.shutdown();
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
});
