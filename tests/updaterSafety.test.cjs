const {test} = require('node:test');
const assert = require('node:assert/strict');
const load = require('./loadModule.cjs');
require('ts-node').register({transpileOnly: true});
const titleHelper = require('../src/helpers/metadataTitle.ts');
const candidateHelper = require('../src/helpers/metadataCandidate.ts');

function setup(overrides = {}) {
  const calls = {pages: [], selections: [], attempts: [], attemptFingerprints:[], writes: [], payloads: [], corrections:[], localWrites:[], covers: [], logs: [], lookups:[], ddl:0};
  const metadata = {maxAttempts: 3, googleApiKeys: ['fake'], dailyRequestLimit: 1000,
    requestSafetyBufferPerKey: 100, requestDelayMs: 0, canUseOpenLibrary: true, batchSize: 2,
    mode:'write',archiveIds:[],maxArchivesPerRun:overrides.ceiling??5,maxRequestsPerRun:80,...overrides.config};
  const state=overrides.state??{cursor:0,closed:0};
  const rows = [1, 2, 3, 4, 5].map(id => ({id, name: `Book ${id}.pdf`, localDetails: {title: `Book ${id}`}}));
  const logger = Object.fromEntries(['info', 'warn', 'error'].map(level => [level, (...args) => calls.logs.push([level, ...args])]));
  const repository = {
    async getArchivesNeedingMetadata(max, limit, after,selection) {
      calls.pages.push({max, limit, after});
      calls.selections.push(selection);
      if (overrides.dbError) throw Error('DB unavailable');
      return rows.filter(row => row.id > after&&(!selection.ids.length||selection.ids.includes(row.id))).slice(0, limit);
    },
    async updateLocalIdentity(id,correction,fingerprint) {
      calls.localWrites.push({id,correction,fingerprint});
      if(overrides.writeError)throw Error('write failed');
      return overrides.updated===false?undefined:'corrected-fingerprint';
    },
    async updateWebDetails(id,payload,fingerprint,correction) { if(overrides.writeError)throw Error('write failed'); calls.writes.push(id); calls.payloads.push(JSON.parse(payload)); calls.corrections.push(correction); return overrides.updated !== false; }
  };
  const control = {async ensureTable() {calls.ddl++;}, async incrementAttempts(id,max,fingerprint) { calls.attempts.push(id); calls.attemptFingerprints.push(fingerprint); return 1; }};
  const modules = {
    '(src)/services/MetadataRunState':{MetadataRunState:class{
      constructor(persist){this.persist=persist;this.afterId=persist?state.cursor:0;}
      async open(){} async close(){state.closed++;}
      async advance(id){if(this.persist)state.cursor=id;this.afterId=id;}
    }},
    '(src)/services/RecoveryLookupService':{RecoveryLookupService:class{
      constructor(tracker,gate){this.gate=gate;}
      async search(archive){
        calls.lookups.push(archive.id);
        if(overrides.countRequests)this.gate.record();
        if(overrides.lookup)return overrides.lookup;
        const match=typeof overrides.ol==='object'?overrides.ol:typeof overrides.google==='object'?overrides.google:undefined;
        const error=[overrides.ol,overrides.google].some(v=>v==='error'||v==='limited');
        const rejected=[overrides.ol,overrides.google].includes('rejected');
        return {match,provider:typeof overrides.ol==='object'?'ol':'google',status:match?'match':error?'deferred':rejected?'rejected':'none',rejected,errors:error?1:0,limited:false};
      }
    }},
    '(src)/config/configuration': {config: {production: {metadata}}},
    '(src)/helpers/logger': {createLogger: () => logger},
    '(src)/helpers/metadataTitle': titleHelper,
    '(src)/helpers/metadataCandidate': candidateHelper,
    '(src)/repositories/ArchiveRepository': {ArchiveRepository: {getInstance: () => repository}},
    '(src)/repositories/MetadataLookupControlRepository': {MetadataLookupControlRepository: {getInstance: () => control}},
    '(src)/services/OpenLibraryService': {OpenLibraryService: {getInstance: () => ({searchByTitle: async (...args) => {if(overrides.countRequests)args.at(-1).record();return overrides.ol;}})}},
    '(src)/services/GoogleBooksService': {GoogleBooksService: {getInstance: () => ({searchByTitle: async () => overrides.google})}},
    '(src)/services/CoverService': {CoverService: {getInstance: () => ({downloadAndConvertCover: async (...args) => { calls.covers.push(args); return false; }})}},
    '(src)/services/RequestTracker': {RequestTracker: class {
      hasKeys() { return metadata.googleApiKeys.length > 0; }
      async getEffectiveLimit() { return overrides.ceiling ?? 5; }
      async getWaitTimeUntilAvailableKeyMs() { return 0; }
      async getUsageSummary() { return []; }
    }}
  };
  const service = load('services/MetadataUpdaterService.ts', modules).MetadataUpdaterService.getInstance();
  return {calls, service, state, summary: () => calls.logs.findLast(row => row[2] === '=== Metadata update summary ===')[1]};
}
test('automatic synopsis publication keeps provenance, while preview and concurrent edits never claim a saved record',async()=>{
  const details={title:'Book',description:'Provider synopsis',_source:'google-books',_providerId:'volume123',_metadataScope:'work'};
  for(const mode of ['write','preview']){
    const f=setup({config:{mode,archiveIds:[1]},lookup:{status:'match',match:{webDetails:details},provider:'google',
      evidence:'local-title',rejected:false,errors:0,limited:false}});
    await f.service.runUpdate();
    assert.deepEqual(f.calls.attempts,[]);
    assert.deepEqual(f.calls.payloads,mode==='write'?[details]:[]);
    const log=f.calls.logs.find(row=>row[2]===(mode==='write'?'Metadata saved':'Preview candidate; no metadata or cover saved'));
    assert.equal(log[1].providerId,'volume123');assert.equal(log[1].evidence,'local-title');
    assert.ok(!JSON.stringify(f.calls.logs).includes('Provider synopsis'));
  }
  const f=setup({updated:false,google:{webDetails:details}});await f.service.runUpdate();
  assert.ok(!f.calls.logs.some(row=>row[2]==='Metadata saved'));
});
test('keyset batches stay small, visit each archive once, and respect run ceiling', async () => {
  const {service, calls, summary} = setup({ceiling: 4});
  await service.runUpdate();
  assert.deepEqual(calls.pages, [{max: 3, limit: 2, after: 0}, {max: 3, limit: 2, after: 2}]);
  assert.deepEqual(calls.attempts, [1, 2, 3, 4]);
  assert.equal(summary().completed, true);
});
test('insufficient metadata consumes one capped attempt, never publishes or downloads a cover',async()=>{
  const f=setup({lookup:{status:'insufficient',minimal:true,rejected:false,errors:0,limited:false}});
  await f.service.runUpdate();
  assert.deepEqual(f.calls.writes,[]);assert.deepEqual(f.calls.covers,[]);
  assert.deepEqual(f.calls.attempts,[1,2,3,4,5]);
  assert.equal(f.summary().insufficient,5);assert.equal(f.summary().insufficientAttempts,5);
  assert.equal(f.summary().notFound,0);assert.equal(f.summary().googleMatches,0);
});
test('minimal result with unresolved errors or quota never consumes attempts',async()=>{
  for(const detail of [{errors:2,limited:false},{errors:0,limited:true}]){
    const f=setup({lookup:{status:'deferred',minimal:true,rejected:false,...detail}});
    await f.service.runUpdate();
    assert.deepEqual(f.calls.writes,[]);assert.deepEqual(f.calls.covers,[]);assert.deepEqual(f.calls.attempts,[]);
    assert.equal(f.summary().insufficient,5);assert.equal(f.summary().deferred,5);
    assert.equal(f.summary().insufficientAttempts,0);
  }
});

test('unverified useful identity is counted separately, not published or mistaken for no results',async()=>{
  for(const status of ['deferred','insufficient']){
    const f=setup({lookup:{status,identityUnverified:true,rejected:false,errors:status==='deferred'?2:0,limited:false}});
    await f.service.runUpdate();
    assert.deepEqual(f.calls.writes,[]);assert.deepEqual(f.calls.localWrites,[]);assert.deepEqual(f.calls.covers,[]);
    assert.deepEqual(f.calls.attempts,status==='deferred'?[]:[1,2,3,4,5]);
    assert.equal(f.summary().identityUnverified,5);assert.equal(f.summary().notFound,0);
    assert.equal(f.summary().insufficient,0);assert.equal(f.summary().googleMatches,0);
    assert.equal(f.summary().insufficientAttempts,status==='deferred'?0:5);
  }
  const f=setup({config:{mode:'preview'},lookup:{status:'insufficient',identityUnverified:true,rejected:false,errors:0,limited:false}});
  await f.service.runUpdate();assert.equal(f.summary().identityUnverified,5);assert.equal(f.summary().previewNotFound,0);
  assert.deepEqual(f.calls.attempts,[]);assert.deepEqual(f.calls.writes,[]);
});
test('preview of insufficient metadata is not a publishable match and makes no writes',async()=>{
  const f=setup({config:{mode:'preview'},lookup:{status:'insufficient',minimal:true,rejected:false,errors:0,limited:false}});
  await f.service.runUpdate();
  assert.deepEqual(f.calls.writes,[]);assert.deepEqual(f.calls.attempts,[]);assert.equal(f.calls.ddl,0);
  assert.equal(f.summary().previewMatches,0);assert.equal(f.summary().insufficient,5);
  assert.equal(f.summary().previewNotFound,0);
});
test('paused service makes no database/provider calls',async()=>{
  const {service,calls}=setup({config:{mode:'paused'}});await service.runUpdate();
  assert.deepEqual(calls.pages,[]);assert.equal(calls.ddl,0);assert.deepEqual(calls.writes,[]);
});
test('preview selects explicit IDs including exhausted, without DDL, metadata, covers or attempts',async()=>{
  for(const ol of [undefined,{webDetails:{title:'Book'},coverUrl:'fake'}]){
    const {service,calls,summary}=setup({config:{mode:'preview',archiveIds:[2,4]},ol});await service.runUpdate();
    assert.equal(calls.ddl,0);assert.deepEqual(calls.writes,[]);assert.deepEqual(calls.covers,[]);assert.deepEqual(calls.attempts,[]);
    assert.equal(summary().processed,2);assert.equal(summary().previewMatches,ol?2:0);
    assert.ok(calls.selections.every(s=>s.includeExhausted&&s.ids.join(',')==='2,4'));
  }
});
test('write mode never releases exhausted and obeys independent archive/request ceilings',async()=>{
  const first=setup({config:{archiveIds:[1,2,3],maxArchivesPerRun:1}});await first.service.runUpdate();
  assert.deepEqual(first.calls.attempts,[1]);assert.ok(first.calls.selections.every(s=>!s.includeExhausted));
  const second=setup({config:{maxRequestsPerRun:1},countRequests:true,ol:{webDetails:{title:'Book'}}});await second.service.runUpdate();
  assert.equal(second.summary().requests,1);assert.equal(second.summary().processed,1);assert.equal(second.summary().requestLimitReached,true);
});
test('outages and quota exhaustion never consume archive attempts', async () => {
  for (const failure of [{ol: 'error'}, {google: 'error'}, {google: 'limited'}]) {
    const {service, calls, summary} = setup(failure);
    await service.runUpdate();
    assert.deepEqual(calls.attempts, []);
    assert.equal(summary().deferred, 5);
  }
});
test('rejected candidates are reported separately from provider errors', async () => {
  const {service, calls, summary} = setup({ol: 'rejected'});
  await service.runUpdate();
  assert.equal(summary().rejected, 5);
  assert.equal(summary().notFound, 5);
  assert.equal(calls.attempts.length, 5);
});
test('concurrent metadata edits do not trigger a second provider/write or a cover download', async () => {
  const {service, calls, summary} = setup({updated: false, ol: {webDetails: {title: 'Book'}, coverUrl: 'fake'}});
  await service.runUpdate();
  assert.equal(calls.writes.length, 5);
  assert.deepEqual(calls.attempts, []);
  assert.deepEqual(calls.covers, []);
  assert.equal(summary().changedMeanwhile, 5);
});
test('successful alternate provider can save despite first provider error; cover failure is not lookup failure', async () => {
  const {service, calls, summary} = setup({ol: 'error', google: {webDetails: {title: 'Book'}, coverUrl: 'fake'}});
  await service.runUpdate();
  assert.equal(summary().googleMatches, 5);
  assert.equal(summary().coverFailedOrExisting, 5);
  assert.equal(calls.attempts.length, 0);
});
test('no configured provider does not consume attempts', async () => {
  const {service, calls} = setup({config: {canUseOpenLibrary: false, googleApiKeys: []}});
  await service.runUpdate();
  assert.deepEqual(calls.pages, []);
  assert.deepEqual(calls.attempts, []);
});
test('DB failure ends run with partial summary and releases running guard', async () => {
  const {service, calls, summary} = setup({dbError: true});
  await service.runUpdate();
  assert.equal(summary().completed, false);
  await service.runUpdate();
  assert.equal(calls.pages.length, 2);
  assert.deepEqual(calls.attempts, []);
});
test('transient failures advance traversal, survive a new service, and wrap without consuming attempts',async()=>{
  const state={cursor:0,closed:0};
  for(const ids of [[1,2],[3,4],[5],[1,2]]){
    const f=setup({state,ol:'error',config:{maxArchivesPerRun:2}});await f.service.runUpdate();
    assert.deepEqual(f.calls.lookups,ids);
    assert.equal(f.summary().processed,ids.length);
    assert.deepEqual(f.calls.attempts,[]);
    assert.equal(f.calls.pages[0].after,ids[0]===1?0:ids[0]-1);
  }
  assert.equal(state.closed,4);
});
test('failed write does not checkpoint past the archive; selected exhausted never releases the catalogue',async()=>{
  const f=setup({writeError:true,ol:{webDetails:{title:'Book'}}});await f.service.runUpdate();
  assert.equal(f.state.cursor,0);assert.equal(f.summary().completed,false);
  const selected=setup({config:{archiveIds:[2],retryExhausted:true},ol:'error'});await selected.service.runUpdate();
  assert.deepEqual(selected.calls.attempts,[]);assert.equal(selected.state.cursor,0);
  assert.ok(selected.calls.selections.every(s=>s.ids.join(',')==='2'&&s.includeExhausted));
});

const correction={title:'Correct title',author:'Correct Writer',before:{title:'Correct Writer',author:'Correct title'},
  sourceName:'Writer, Correct - Correct title.pdf',evidence:'google-isbn-confirmed-field-swap',
  isbn:'9780306406157',provider:'google',providerId:'verified-google-record'};
test('verified Google identity repair is independent of useful, insufficient and technically deferred enrichment',async()=>{
  for(const status of ['match','insufficient','deferred']){
    const f=setup({config:{archiveIds:[1]},lookup:{status,minimal:status==='insufficient',localCorrection:correction,
      errors:status==='deferred'?1:0,rejected:false,limited:false,provider:'google',
      ...(status==='match'?{match:{webDetails:{title:'Correct title',description:'Useful'}}}:{})}});
    await f.service.runUpdate();assert.equal(f.summary().completed,true);assert.equal(f.summary().localCorrections,1);
    assert.equal(f.calls.localWrites.length,status==='match'?0:1);
    assert.equal(f.calls.writes.length,status==='match'?1:0);
    if(status==='match')assert.equal(f.calls.corrections[0],correction);
    assert.deepEqual(f.calls.attempts,status==='insufficient'?[1]:[]);
    if(f.calls.attempts.length)assert.equal(f.calls.attemptFingerprints[0],'corrected-fingerprint');
    assert.equal(f.summary().googleMatches,status==='match'?1:0);
  }
});
test('repair preview, lost update and failed save never change attempts, covers or run success incorrectly',async()=>{
  const lookup={status:'insufficient',minimal:true,localCorrection:correction,errors:0,rejected:false,limited:false};
  const preview=setup({config:{mode:'preview',archiveIds:[1]},lookup});await preview.service.runUpdate();
  assert.deepEqual(preview.calls.localWrites,[]);assert.deepEqual(preview.calls.writes,[]);assert.deepEqual(preview.calls.attempts,[]);
  assert.equal(preview.summary().previewLocalCorrections,1);assert.equal(preview.summary().localCorrections,0);
  const raced=setup({updated:false,lookup});await raced.service.runUpdate();
  assert.equal(raced.summary().localCorrections,0);assert.equal(raced.summary().changedMeanwhile,5);
  assert.deepEqual(raced.calls.attempts,[]);assert.deepEqual(raced.calls.covers,[]);
  const failed=setup({writeError:true,lookup});await failed.service.runUpdate();
  assert.equal(failed.summary().completed,false);assert.equal(failed.state.cursor,0);assert.deepEqual(failed.calls.attempts,[]);
});
