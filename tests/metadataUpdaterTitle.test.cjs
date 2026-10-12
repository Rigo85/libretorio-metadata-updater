const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
require('ts-node').register({transpileOnly: true});
const titleHelper = require('../src/helpers/metadataTitle.ts');
const candidateHelper = require('../src/helpers/metadataCandidate.ts');

test('updater uses the resolver and reports its source without starting real providers or DB', async () => {
  const queries = [], writes = [], logs = [];
  const archives = [
    {id: 1, name: 'Noisy name - Author.epub', localDetails: Object.freeze({title: 'A useful title'})},
    {id: 2, name: 'Another name.pdf', localDetails: {title: 42}},
    {id: 3, name: 'Shaw, Bob - El palacio de la eternidad.pdf', localDetails: {title:'Shaw, Bob','author(s)':'El palacio de la eternidad'}}
  ];
  const mocks = {
    '(src)/services/MetadataRunState':{MetadataRunState:class{afterId=0;async open(){}async close(){}async advance(id){this.afterId=id;}}},
    '(src)/services/RecoveryLookupService':{RecoveryLookupService:class{async search(archive){
      const {title,author}=titleHelper.resolveMetadataSearch(archive.name,archive.localDetails,candidateHelper.resolveMetadataAuthor(archive.localDetails));
      queries.push(title.title);if(title.title==='Shaw Bob')assert.equal(author,'El palacio de la eternidad');
      return {status:'match',provider:'ol',errors:0,rejected:false,limited:false,match:{webDetails:{title:title.title}}};
    }}},
    '(src)/config/configuration': {config: {production: {metadata: {mode:'write',archiveIds:[],maxArchivesPerRun:500,maxRequestsPerRun:80,maxAttempts: 3, googleApiKeys: [], dailyRequestLimit: 1000, requestSafetyBufferPerKey: 100, requestDelayMs: 0, canUseOpenLibrary: true, batchSize: 50}}}},
    '(src)/helpers/metadataTitle': titleHelper,
    '(src)/helpers/metadataCandidate': candidateHelper,
    '(src)/helpers/logger': {createLogger: () => ({info: (...v) => logs.push(v), warn: (...v) => logs.push(v), error: (...v) => { throw Error(JSON.stringify(v)); }})},
    '(src)/repositories/MetadataLookupControlRepository': {MetadataLookupControlRepository: {getInstance: () => ({ensureTable: async () => {}, getExhaustedArchiveIds: async () => [99]})}},
    '(src)/repositories/ArchiveRepository': {ArchiveRepository: {getInstance: () => ({
      getArchivesNeedingMetadata: async (attempts, limit, after) => { assert.equal(attempts, 3); assert.equal(limit, 50); return after ? [] : archives; },
      updateWebDetails: async (id, json) => { writes.push({id, json}); return true; }
    })}},
    '(src)/services/OpenLibraryService': {OpenLibraryService: {getInstance: () => ({searchByTitle: async (title,author) => { queries.push(title); if(title==='El palacio de la eternidad')assert.equal(author,'Bob Shaw'); return {webDetails: {title}}; }})}},
    '(src)/services/GoogleBooksService': {},
    '(src)/services/CoverService': {},
    '(src)/services/RequestTracker': {RequestTracker: class { hasKeys() { return false; } }}
  };
  const source = fs.readFileSync(path.join(__dirname, '../src/services/MetadataUpdaterService.ts'), 'utf8');
  const code = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
  const exports = {};
  vm.runInNewContext(code, {exports, require: id => {
    assert.ok(Object.hasOwn(mocks, id), `Unexpected dependency: ${id}`);
    return mocks[id];
  }, setTimeout: callback => callback()});
  await exports.MetadataUpdaterService.getInstance().runUpdate();
  assert.deepEqual(queries, ['A useful title', 'Another name','Shaw Bob']);
  assert.deepEqual(writes.map(x => x.id), [1, 2,3]);
  const processed = logs.filter(x => x[1] === 'Processing archive').map(x => x[0]);
  assert.equal(processed[0].searchTitleSource, 'localDetails');
  assert.equal(processed[0].searchTitleReason, 'local-title');
  assert.equal(processed[1].searchTitleSource, 'filename');
  assert.equal(processed[1].searchTitleReason, 'invalid-title');
  assert.equal(processed[2].searchTitleReason,'local-title');
});
