const {test} = require('node:test');
const assert = require('node:assert/strict');
const load = require('./loadModule.cjs');
require('ts-node').register({transpileOnly: true});
const helpers = require('../src/helpers/metadataCandidate.ts');
const http = require('../src/helpers/metadataHttp.ts');
const lookup = require('../src/helpers/metadataLookup.ts');
const logger = {info() {}, warn() {}, error() {}};
function setup(provider, get, options={}) {
  return load(`services/${provider}Service.ts`, {
    axios: {get}, '(src)/helpers/logger': {createLogger: () => options.logger??logger},
    '(src)/helpers/metadataCandidate': helpers, '(src)/helpers/metadataHttp': http,
    '(src)/helpers/metadataLookup':lookup,
    '(src)/config/configuration':{config:{production:{metadata:{requestDelayMs:0}}}}
  },options.globals)[`${provider}Service`].getInstance();
}
function tracker() {
  return {reservations: 0, marked: 0, cooldowns: 0,
    async getAvailableKey() { return 'secret-key'; },
    async consumeRequest() { this.reservations++; return true; },
    async markKeyExhausted() { this.marked++; },
    async registerRateLimitHit() { this.cooldowns++; return 30; }};
}
test('Google bounds HTTP, queries title/author, validates candidates and maps ISBN only', async () => {
  const t = tracker();
  const service = setup('GoogleBooks', async (url, options) => {
    assert.equal(t.reservations, 1);
    assert.equal(options.timeout, 20000);
    assert.equal(options.maxContentLength, 2 * 1024 * 1024);
    assert.equal(options.params.maxResults, 5);
    assert.match(options.params.q, /inauthor:/);
    return {data: {totalItems: 1, items: [{volumeInfo: {title: 'Dune', authors: ['Frank Herbert'], industryIdentifiers: [{type: 'OTHER', identifier: 'bad'}, {type: 'ISBN_13', identifier: '9781234567890'}]}}]}};
  });
  const result = await service.searchByTitle('Dune', t, 'Frank Herbert');
  assert.deepEqual([...result.webDetails.isbn], ['9781234567890']);
});
test('run request ceiling includes Google retries and OpenLibrary fallback',async()=>{
 for(const provider of ['GoogleBooks','OpenLibrary']){
  let used=0,calls=0;const gate={available:()=>used<1,record:()=>used<1?!!++used:false},t=tracker();
  const service=setup(provider,async()=>{calls++;if(provider==='GoogleBooks')throw {response:{status:503}};return {data:{docs:[]}};});
  const result=provider==='GoogleBooks'?await service.searchByTitle('Dune',t,'Frank Herbert','Dune',gate):await service.searchByTitle('Dune','Frank Herbert','Dune',gate);
  assert.equal(result,'limited');assert.equal(calls,1);assert.equal(used,1);if(provider==='GoogleBooks')assert.equal(t.reservations,1);
 }
});
test('transient error diagnostics preserve reason, Retry-After and elapsed time without exposing the key',async()=>{
 const logs=[],options={logger:{info(){},warn:(data,message)=>logs.push({data,message}),error(){}}};let calls=0;
 const service=setup('GoogleBooks',async()=>{if(++calls===1)throw {response:{status:503,headers:{'retry-after':'12'},data:{error:{errors:[{reason:'backendFailed'}]}}}};return {data:{totalItems:0}};},options);
 await service.searchByTitle('Dune',tracker());const error=logs.find(l=>l.message==='Google Books HTTP failure').data;
 assert.equal(error.retryAfterMs,12000);assert.equal(error.reasons[0],'backendFailed');assert.ok(error.elapsedMs>=0);assert.ok(!JSON.stringify(logs).includes('secret-key'));
});
test('Retry-After parsing accepts seconds/date and rejects malformed values',()=>{
 assert.equal(http.retryAfterMilliseconds('12'),12000);assert.equal(http.retryAfterMilliseconds('Sun, 11 Oct 2026 00:00:00 GMT',Date.parse('2026-10-10T23:59:50Z')),10000);
 for(const value of [undefined,{},'-1','1.5','tomorrow','x'.repeat(129)])assert.equal(http.retryAfterMilliseconds(value),undefined);
});
test('Google rechecks and reserves on each retry; limit is not no-results', async () => {
  let calls = 0;
  const t = tracker();
  t.consumeRequest = async () => ++t.reservations === 1;
  const service = setup('GoogleBooks', async () => { calls++; throw {response: {status: 503}}; });
  assert.equal(await service.searchByTitle('Dune', t), 'limited');
  assert.equal(calls, 1);
  assert.equal(t.reservations, 2);
});
test('Google retries transient errors at most twice', async () => {
  const t = tracker();
  const service = setup('GoogleBooks', async () => { throw {response: {status: 503}}; });
  assert.equal(await service.searchByTitle('Dune', t), 'error');
  assert.equal(t.reservations, 3);
});
test('Google cannot call HTTP when quota storage fails', async () => {
  const t = tracker();
  t.consumeRequest = async () => { throw Error('Redis offline'); };
  const service = setup('GoogleBooks', async () => assert.fail('Unexpected HTTP'));
  await assert.rejects(service.searchByTitle('Dune', t), /Redis offline/);
});
test('Google separates rate limit and daily quota', async () => {
  for (const [status, reason] of [[429, 'rateLimitExceeded'], [403, 'dailyLimitExceeded']]) {
    const t = tracker();
    const service = setup('GoogleBooks', async () => { throw {response: {status, data: {error: {errors: [{reason}]}}}}; });
    assert.equal(await service.searchByTitle('Dune', t), 'error');
    assert.equal(t.cooldowns, status === 429 ? 1 : 0);
    assert.equal(t.marked, status === 403 ? 1 : 0);
  }
});
test('malformed provider responses are errors, not no-match', async () => {
  for (const provider of ['GoogleBooks', 'OpenLibrary']) {
    const service = setup(provider, async () => ({data: {}}));
    assert.equal(await service.searchByTitle('Dune', tracker()), 'error');
  }
});
test('OpenLibrary uses a small result set and rejects incompatible matches', async () => {
  const service = setup('OpenLibrary', async (url, options) => {
    assert.equal(options.params.limit, 5);
    assert.equal(options.params.author, 'Frank Herbert');
    assert.ok(options.signal);
    return {data: {docs: [{title: 'Other book'}]}};
  });
  assert.equal(await service.searchByTitle('Dune', 'Frank Herbert'), 'rejected');
});
test('malformed Google error payload remains an operational error', async () => {
  const service = setup('GoogleBooks', async () => { throw {response:{status:400,data:{error:{errors:'invalid'}}}}; });
  assert.equal(await service.searchByTitle('Dune',tracker()),'error');
});
test('Google fallback uses general query but still requires matching author and counts every request',async()=>{
  const t=tracker(), queries=[];
  const service=setup('GoogleBooks',async(url,options)=>{
    queries.push(options.params.q);
    if(queries.length===1)return {data:{totalItems:0}};
    return {data:{totalItems:2,items:[
      {volumeInfo:{title:'Dune',authors:['Wrong Person']}},
      {volumeInfo:{title:'Dune',authors:['Frank Herbert']}}
    ]}};
  });
  const result=await service.searchByTitle('Dune',t,'Frank Herbert','Dune');
  assert.equal(result.webDetails.author_name[0],'Frank Herbert');
  assert.deepEqual(queries,['intitle:"Dune" inauthor:"Frank Herbert"','Dune']);
  assert.equal(t.reservations,2);
});
test('OpenLibrary fallback uses q without removing author validation',async()=>{
  const queries=[];
  const service=setup('OpenLibrary',async(url,options)=>{
    queries.push(options.params);
    return {data:{docs:queries.length===1?[]:[{title:'Dune',author_name:['Wrong Person']}]}};
  });
  assert.equal(await service.searchByTitle('Dune','Frank Herbert','Dune'),'rejected');
  assert.equal(queries.length,2);
  assert.equal(queries[1].q,'Dune');
  assert.equal(queries[1].author,undefined);
});
