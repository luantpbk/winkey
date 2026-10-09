import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import console from 'node:console';
import { URL } from 'node:url';
const source = fs.readFileSync(new URL('./hls-viewers.js', import.meta.url), 'utf8');
const util = fs.readFileSync(new URL('./utils.mjs', import.meta.url), 'utf8');
const fixture = JSON.parse(fs.readFileSync(new URL('./mock-video.json', import.meta.url), 'utf8'));
const summary = Object.fromEntries(
  ['id', 'title', 'owner', 'duration_ms', 'view_count', 'published_at'].map((k) => [k, fixture[k]]),
);
summary.thumbnail_url = fixture.playback.thumbnail_url;
async function run(name, cfg = {}) {
  let clock = 0,
    segmentCalls = 0;
  const calls = [],
    metrics = {};
  class Metric {
    constructor(name) {
      this.name = name;
      metrics[name] = [];
    }
    add(x) {
      metrics[this.name].push(x);
    }
  }
  const math = Object.create(Math);
  math.random = () => cfg.random ?? 0.5;
  const ctx = vm.createContext({
    __ENV: { TARGET_URL: 'http://127.0.0.1:17878' },
    open() {
      throw Error('no seed');
    },
    Date: { now: () => clock },
    Math: math,
    console,
  });
  const get = (url) => {
    calls.push(url);
    let status = 200,
      body = '',
      elapsed = 0;
    if (url.includes('?sort='))
      body = JSON.stringify({ items: cfg.empty ? [] : [summary], next_cursor: null });
    else if (url.endsWith('/v1/videos/' + fixture.id))
      body = JSON.stringify({
        ...fixture,
        visibility: cfg.private ? 'PRIVATE' : 'PUBLIC',
        playback: cfg.missingPlayback ? null : fixture.playback,
      });
    else if (url.endsWith('/manifest.m3u8')) {
      status = 404;
      body = 'missing';
    } else if (url.endsWith('/master.m3u8'))
      body = cfg.invalidMaster
        ? '#EXTM3U\n'
        : '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\n480p/index.m3u8\n';
    else if (url.endsWith('/index.m3u8'))
      body =
        `#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:${cfg.segDuration ?? 4},\nseg_00000.m4s\n` +
        (cfg.single ? '' : `#EXTINF:${cfg.segDuration ?? 4},\nseg_00001.m4s\n`) +
        `#EXT-X-ENDLIST\n`;
    else if (url.endsWith('.m4s')) {
      segmentCalls++;
      status =
        (cfg.failFirst && segmentCalls === 1) || (cfg.failRemaining && segmentCalls > 1)
          ? 500
          : 200;
      body = 'bytes';
      elapsed = segmentCalls === 1 ? 1000 : segmentCalls === 2 ? (cfg.secondMs ?? 100) : 0.000001;
    } else throw Error('unexpected URL ' + url);
    clock += elapsed;
    return { status, body, timings: { duration: elapsed } };
  };
  const mocks = {
    'k6/http': { default: { get } },
    k6: {
      sleep(s) {
        clock += s * 1000;
      },
      fail(msg) {
        throw Error(msg);
      },
    },
    'k6/metrics': { Rate: Metric, Trend: Metric, Counter: Metric },
    'k6/data': {
      SharedArray: class {
        constructor(_name, fn) {
          return fn();
        }
      },
    },
  };
  const mod = new vm.SourceTextModule(source, { context: ctx });
  await mod.link((id) =>
    id === './utils.mjs'
      ? new vm.SourceTextModule(util, { context: ctx })
      : new vm.SyntheticModule(
          Object.keys(mocks[id]),
          function () {
            for (const [k, v] of Object.entries(mocks[id])) this.setExport(k, v);
          },
          { context: ctx },
        ),
  );
  await mod.evaluate();
  let error = null;
  try {
    mod.namespace.default(mod.namespace.setup());
  } catch (e) {
    error = e.message;
  }
  const sum = (n) => (metrics[n] ?? []).reduce((a, b) => a + Number(b), 0);
  const watch = sum('total_watch_time_ms'),
    stall = sum('total_stall_time_ms');
  const rate = metrics.aggregate_rebuffer_ratio.length
    ? sum('aggregate_rebuffer_ratio') / metrics.aggregate_rebuffer_ratio.length
    : null;
  const out = {
    name,
    watch_ms: watch,
    non_seek_stall_ms: stall,
    exact_ratio: watch + stall ? stall / (watch + stall) : null,
    actual_rate: rate,
    elapsed_ms: clock,
    segment_calls: segmentCalls,
    http_failure_samples: metrics.http_req_failed.filter(Boolean).length,
    startup_samples: metrics.startup_time.length,
    error,
    requested_invented_manifest: calls.some((x) => x.endsWith('/manifest.m3u8')),
    requested_init: calls.some((x) => x.endsWith('init.mp4')),
    exports: Object.getOwnPropertyNames(mod.namespace),
  };
  console.log(JSON.stringify(out));
  return out;
}
assert.equal((await run('empty pool', { empty: true })).error.startsWith('FAIL:'), true);
assert.equal(
  (await run('missing playback', { missingPlayback: true })).requested_invented_manifest,
  true,
);
assert.equal((await run('invalid master', { invalidMaster: true })).watch_ms, 0);
assert.ok((await run('first segment 500', { failFirst: true })).watch_ms > 0);
assert.ok((await run('remaining segments 500', { failRemaining: true })).watch_ms > 0);
assert.equal((await run('PRIVATE detail accepted', { private: true })).segment_calls > 0, true);
assert.equal((await run('normal valid fMP4')).requested_init, false);
const near = await run('quantization false PASS', {
  single: true,
  segDuration: 2.4,
  secondMs: 2449,
});
assert.ok(near.exact_ratio > 0.01 && near.actual_rate === 0);
const short = await run('quantization false FAIL', {
  single: true,
  segDuration: 2.5,
  secondMs: 2550.01,
});
assert.ok(short.exact_ratio < 0.01 && short.actual_rate > 0.01);
const uctx = vm.createContext({});
const umod = new vm.SourceTextModule(util, { context: uctx });
await umod.link(() => {});
await umod.evaluate();
for (const [rel, base] of [
  ['../720p/index.m3u8', 'https://media.example/v/x/hls/480p/index.m3u8'],
  ['//cdn.example/seg.m4s', 'https://media.example/v/x/index.m3u8'],
  ['seg.m4s', 'https://media.example/v/x/index.m3u8?sig=a/b'],
])
  console.log(
    JSON.stringify({
      url_input: rel,
      base,
      expected: new URL(rel, base).href,
      actual: umod.namespace.resolveUrl(rel, base),
    }),
  );
console.log(
  'Actual-source offline assertions: 9/9 PASS (confirmed defects, not acceptance of harness).',
);
