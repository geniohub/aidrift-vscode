import { test } from "node:test";
import assert from "node:assert/strict";
import { CommitMetaCache } from "../src/commit-meta-cache";

const fakeMeta = (sha: string) =>
  ({ event: { commitHash: sha } }) as any;

test("returns fetcher result and caches it", async () => {
  let calls = 0;
  const cache = new CommitMetaCache(async (sha) => {
    calls++;
    return fakeMeta(sha);
  }, 10);
  const a = await cache.get("aaa");
  const b = await cache.get("aaa");
  assert.equal(calls, 1);
  assert.equal(a, b);
});

test("caches null (404) and does not retry", async () => {
  let calls = 0;
  const cache = new CommitMetaCache(async () => {
    calls++;
    return null;
  }, 10);
  const a = await cache.get("missing");
  const b = await cache.get("missing");
  assert.equal(calls, 1);
  assert.equal(a, null);
  assert.equal(b, null);
});

test("evicts oldest entry when over capacity", async () => {
  let calls = 0;
  const cache = new CommitMetaCache(async (sha) => {
    calls++;
    return fakeMeta(sha);
  }, 2);
  await cache.get("a"); // 1
  await cache.get("b"); // 2
  await cache.get("c"); // evicts 'a'
  await cache.get("a"); // re-fetches
  assert.equal(calls, 4);
});

test("invalidate(sha) forces a re-fetch", async () => {
  let calls = 0;
  const cache = new CommitMetaCache(async (sha) => {
    calls++;
    return fakeMeta(sha);
  }, 10);
  await cache.get("a");
  cache.invalidate("a");
  await cache.get("a");
  assert.equal(calls, 2);
});

test("clear() drops everything", async () => {
  let calls = 0;
  const cache = new CommitMetaCache(async (sha) => {
    calls++;
    return fakeMeta(sha);
  }, 10);
  await cache.get("a");
  cache.clear();
  await cache.get("a");
  assert.equal(calls, 2);
});
