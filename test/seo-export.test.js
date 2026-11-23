// Run after npm run build. These inspect the produced documents, not just config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { PUBLIC_GUIDE_PATHS } from '../server/seo-guide.js';

const out = path.resolve(import.meta.dirname, '../web/out');
const origin = process.env.SITE_URL || 'https://gta-transit-live.onrender.com';
const read = file => readFile(path.join(out,file),'utf8');
const getAttr = (tag,name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
let built = true;
try { await access(path.join(out,'index.html')); } catch { built = false; }

test('production HTML has complete, unique indexable content and reciprocal locale metadata', {skip:!built}, async () => {
  const titles = new Set();
  const paths = [...PUBLIC_GUIDE_PATHS];
  for (const pathname of paths) {
    const html = await read(pathname === '/' ? 'index.html' : `${pathname.slice(1)}.html`);
    const zh = pathname === '/zh' || pathname.startsWith('/zh/');
    assert.match(html,new RegExp(`<html[^>]+lang="${zh ? 'zh-Hans' : 'en-CA'}"`),pathname);
    assert.equal((html.match(/<h1[\s>]/g)||[]).length,1,`${pathname} must have one h1`);
    const title = html.match(/<title>(.*?)<\/title>/)?.[1];
    assert.ok(title && !titles.has(title),`${pathname} unique title`); titles.add(title);
    const links = html.match(/<link\b[^>]*>/g)||[];
    const canonical = links.filter(tag => getAttr(tag,'rel')==='canonical');
    assert.equal(canonical.length,1,pathname);
    // Next normalizes a root canonical to the bare origin; URL.href restores
    // its equivalent slash form so comparisons reflect actual URL identity.
    assert.equal(new URL(getAttr(canonical[0],'href')).href,`${origin}${pathname}`,pathname);
    const englishPath = zh ? pathname.slice(3)||'/' : pathname;
    const chinesePath = englishPath === '/' ? '/zh' : `/zh${englishPath}`;
    const alternates = links.filter(tag => getAttr(tag,'rel')==='alternate');
    for (const [lang,target] of [['en-CA',englishPath],['zh-Hans',chinesePath],['x-default',englishPath]]) {
      assert.equal(new URL(getAttr(alternates.find(tag=>getAttr(tag,'hrefLang')===lang)||'','href')).href,`${origin}${target}`,`${pathname} ${lang}`);
    }
    const description = (html.match(/<meta\b[^>]*>/g)||[]).find(tag => getAttr(tag,'name')==='description');
    assert.ok((getAttr(description||'','content')||'').length>20,pathname);
    assert.doesNotMatch(html,/<meta[^>]+name="robots"[^>]+content="[^"]*noindex/,pathname);
    const schema = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
    assert.ok(schema,pathname);
    const parsed = JSON.parse(schema);
    assert.equal(parsed['@context'],'https://schema.org');
    const webPage = parsed['@graph'].find(x=>x['@type']==='WebPage');
    assert.equal(webPage.url,`${origin}${pathname}`);
    assert.ok(html.includes('<main id="main">'),pathname);
    const content = html.replace(/<script[\s\S]*?<\/script>/g,'').replace(/<[^>]*>/g,'');
    assert.ok(content.length>600,`${pathname} must contain substantial pre-rendered text`);
  }
});

test('sitemap includes only canonical reviewed pages; robots protects private routes', {skip:!built}, async () => {
  const xml = await read('sitemap.xml');
  const locations = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m=>m[1]);
  assert.equal(new Set(locations).size,PUBLIC_GUIDE_PATHS.size);
  assert.deepEqual(new Set(locations),new Set([...PUBLIC_GUIDE_PATHS].map(p=>`${origin}${p}`)));
  assert.ok(!locations.some(p=>/[?]|\/live|\/api\/|\/login|\/admin/.test(p)));
  const robots = await read('robots.txt');
  for (const p of ['/api/','/admin','/live','/login','/register']) assert.ok(robots.includes(`Disallow: ${p}`));
  assert.ok(robots.includes(`Sitemap: ${origin}/sitemap.xml`));
});

test('public guide does not publish private credentials or pretend to have an imported feed', {skip:!built}, async () => {
  const sources = await read('sources.html');
  assert.doesNotMatch(sources,/postgres(?:ql)?:\/\/|UPSTASH_REDIS_REST_TOKEN|VAPID_PRIVATE_KEY|SESSION_SECRET=/);
  assert.ok(sources.includes('Metrolinx makes no representations or warranties'));
  assert.ok(sources.includes('Scheduled data and live predictions'));
});
