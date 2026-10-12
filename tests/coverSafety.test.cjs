const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const path = require('node:path');
const os = require('node:os');
const {Readable} = require('node:stream');
const load = require('./loadModule.cjs');

async function fixture(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'libretorio-cover-test-'));
  const paths = {covers:path.join(root,'covers'),tempCovers:path.join(root,'temp')};
  await fs.ensureDir(paths.covers);
  await fs.ensureDir(paths.tempCovers);
  const calls = [];
  const logger = {info() {}, warn() {}, error() {}};
  const service = load('services/CoverService.ts', {
    child_process: {execFile(command, args, opts, callback) {
      calls.push('convert');
      assert.equal(command,'cwebp');
      assert.equal(opts.timeout,20000);
      if (options.conversionFailure) return callback(Error('converter failed'));
      fs.writeFile(args.at(-1),'valid-output').then(async () => {
        if (options.race) await fs.writeFile(path.join(paths.covers,'cover-id.webp'),'manual-cover');
        callback(null,'','');
      }).catch(callback);
    }},
    crypto: require('node:crypto'), util: require('node:util'), stream: require('node:stream'),
    'stream/promises': require('node:stream/promises'), path, 'fs-extra':fs,
    axios:{async get(url, opts) {
      calls.push('download');
      assert.equal(opts.timeout,20000);
      if (options.streamFailure) return {data:new Readable({read() {this.destroy(Error('broken stream'));}})};
      if (options.oversized) return {data:Readable.from([Buffer.alloc(21*1024*1024)])};
      return {data:Readable.from(['image bytes'])};
    }},
    '(src)/config/configuration':{config:{production:{paths}}},
    '(src)/helpers/logger':{createLogger:() => logger}
  }).CoverService.getInstance();
  return {root, paths, calls, service};
}
test('cover conversion failure and broken/oversized streams never publish or report success', async () => {
  for (const options of [{conversionFailure:true},{streamFailure:true},{oversized:true}]) {
    const f = await fixture(options);
    try {
      assert.equal(await f.service.downloadAndConvertCover('https://example.invalid/cover','cover-id'),false);
      assert.deepEqual(await fs.readdir(f.paths.covers),[]);
      assert.deepEqual(await fs.readdir(f.paths.tempCovers),[]);
    } finally { await fs.remove(f.root); }
  }
});
test('successful cover publishes complete file and preserves it on subsequent calls', async () => {
  const f = await fixture();
  try {
    assert.equal(await f.service.downloadAndConvertCover('https://example.invalid/cover','cover-id'),true);
    assert.equal(await f.service.downloadAndConvertCover('https://example.invalid/cover','cover-id'),false);
    assert.deepEqual(f.calls,['download','convert']);
    assert.deepEqual(await fs.readdir(f.paths.covers),['cover-id.webp']);
    assert.deepEqual(await fs.readdir(f.paths.tempCovers),[]);
  } finally { await fs.remove(f.root); }
});
test('cover published by another process during download is not overwritten', async () => {
  const f = await fixture({race:true});
  try {
    assert.equal(await f.service.downloadAndConvertCover('https://example.invalid/cover','cover-id'),false);
    assert.equal(await fs.readFile(path.join(f.paths.covers,'cover-id.webp'),'utf8'),'manual-cover');
    assert.deepEqual(await fs.readdir(f.paths.covers),['cover-id.webp']);
  } finally { await fs.remove(f.root); }
});
test('invalid cover identifier cannot escape target directory', async () => {
  const f = await fixture();
  try {
    assert.equal(await f.service.downloadAndConvertCover('https://example.invalid/cover','../elsewhere'),false);
    assert.deepEqual(f.calls,[]);
  } finally { await fs.remove(f.root); }
});
