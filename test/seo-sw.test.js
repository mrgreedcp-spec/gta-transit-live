import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
function worker() {
  const handlers = {}, opened = [], stored = [];
  const origin = 'https://gta.example';
  const scope = {
    URL, Promise, setTimeout,
    location: { origin },
    self: {
      location: { origin },
      addEventListener(name, fn) { handlers[name] = fn; },
      skipWaiting: async () => {},
      clients: {
        matchAll: async () => [],
        openWindow: async url => { opened.push(url); },
        claim: async () => {},
      },
    },
    fetch: async url => ({ ok: true, redirected: url === '/live', clone() { return this; } }),
    caches: { open: async () => ({ put: async (url, response) => stored.push({ url, response }) }) },
  };
  vm.runInNewContext(source, scope, { filename: 'public/sw.js' });
  return { handlers, opened, stored, origin };
}

test('old generic and stop/tab notification payloads all open the live map', async () => {
  const w = worker();
  for (const url of [undefined, '/', '/?stop=miway%3A0085', '/?tab=favs', '/live?tab=favs']) {
    let done;
    w.handlers.notificationclick({
      notification: { close() {}, data: { url } }, waitUntil(p) { done = p; },
    });
    await done;
    const result = new URL(w.opened.at(-1));
    assert.equal(result.pathname, '/live');
    assert.equal(result.search, url && url.includes('?') ? url.slice(url.indexOf('?')) : '');
  }
});

test('service worker never intercepts public guide pages, Next/RSC, login or APIs', () => {
  const w = worker();
  for (const p of ['/', '/zh', '/fare-calculator', '/routes/kipling-to-square-one', '/_next/static/chunks/app.js', '/fare-calculator.txt', '/login', '/api/account/favs']) {
    let intercepted = false;
    w.handlers.fetch({ request: { method: 'GET', url: w.origin + p }, respondWith() { intercepted = true; } });
    assert.equal(intercepted, false, p);
  }
});

test('install cannot cache a login redirect as the live map', async () => {
  const w = worker();
  let done;
  w.handlers.install({ waitUntil(p) { done = p; } });
  await done;
  assert.ok(w.stored.some(x => x.url === '/app.js'));
  assert.ok(!w.stored.some(x => x.url === '/live'));
  assert.ok(!w.stored.some(x => x.url === '/'));
});
