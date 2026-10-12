const {test} = require('node:test');
const assert = require('node:assert/strict');
const load = require('./loadModule.cjs');
const logger = {info() {}, warn() {}, error() {}};

test('manual endpoint rejects paused/invalid requests without starting a lookup', async () => {
  let runs = 0;
  const metadata = {mode: 'paused', action: 'test-action'};
  const controller = load('controllers/home.ts', {
    '(src)/config/configuration': {config: {production: {metadata}}},
    '(src)/helpers/logger': {createLogger: () => logger},
    '(src)/services/MetadataUpdaterService': {MetadataUpdaterService: {
      getInstance: () => ({runUpdate: async () => { runs++; }})
    }}
  });
  const response = {status(code) {this.code = code; return this;}, json(body) {this.body = body; return this;}};
  await controller.checkParameter({params: {action: 'test-action'}}, response);
  assert.equal(response.code, 409);
  assert.equal(response.body.success, false);
  assert.equal(runs, 0);
  await controller.checkParameter({params: {action: 'invalid'}}, response);
  assert.equal(response.code, 400);
  assert.equal(runs, 0);
  metadata.mode = 'preview';
  await controller.checkParameter({params: {action: 'test-action'}}, response);
  assert.equal(response.code, 200);
  assert.equal(runs, 1);
});

test('bootstrap schedules write only; preview cannot silently repeat through cron', async () => {
  for (const mode of ['paused', 'preview', 'write']) {
    const scheduled = [];
    let runs = 0;
    const app = {use() {}, set() {}, get() {}};
    const middleware = () => () => {};
    const express = Object.assign(() => app, {json: middleware, urlencoded: middleware, static: middleware});
    const bootstrap = load('app.ts', {
      dotenv: {config() {}}, express, compression: middleware, helmet: middleware, cors: middleware,
      lusca: {xframe: middleware, xssProtection: middleware}, path: require('node:path'),
      'node-cron': {schedule: (...args) => scheduled.push(args)},
      'moment-timezone': () => ({tz: () => ({format: () => 'test'})}),
      '(src)/config/configuration': {config: {production: {server: {port: 0}, metadata: {mode, cron: '0 3 * * *'}}}},
      '(src)/helpers/logger': {createLogger: () => logger},
      '(src)/controllers/home': {index() {}, checkParameter() {}},
      '(src)/db/RedisAdapter': {initialize: async () => {}},
      '(src)/services/MetadataUpdaterService': {MetadataUpdaterService: {
        getInstance: () => ({runUpdate: async () => { runs++; }})
      }}
    }, {__dirname: '/tmp/metadata-entry-test'}).bootstrap;
    await bootstrap();
    assert.equal(runs, 0);
    assert.equal(scheduled.length, mode === 'write' ? 1 : 0);
    if (scheduled.length) {
      assert.equal(scheduled[0][2].timezone, 'America/Lima');
      await scheduled[0][1]();
      assert.equal(runs, 1);
    }
  }
});
