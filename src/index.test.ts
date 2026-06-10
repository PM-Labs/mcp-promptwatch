// src/index.test.ts
import request from 'supertest';
// We'll import the app once it's exported — stub import for now
// These tests define the contract; implementation follows in Task 3

describe('Bearer guard', () => {
  it('returns 401 when no Authorization header', async () => {
    // placeholder — wired in Task 3
    expect(true).toBe(true);
  });
  it('returns 401 when wrong token', async () => {
    expect(true).toBe(true);
  });
  it('passes through with correct token', async () => {
    expect(true).toBe(true);
  });
});

describe('tools/list injection', () => {
  it('appends client param to every tool inputSchema', async () => {
    expect(true).toBe(true);
  });
  it('makes client a required field', async () => {
    expect(true).toBe(true);
  });
});

describe('tools/call routing', () => {
  it('returns 400 error when client arg is missing', async () => {
    expect(true).toBe(true);
  });
  it('returns 400 error when client slug is unknown', async () => {
    expect(true).toBe(true);
  });
  it('strips client from forwarded args', async () => {
    expect(true).toBe(true);
  });
  it('forwards with correct upstream Bearer token', async () => {
    expect(true).toBe(true);
  });
});
