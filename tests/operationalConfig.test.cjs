const {test}=require('node:test'),assert=require('node:assert/strict'),load=require('./loadModule.cjs');
function config(env={}){return load('config/configuration.ts',{path:require('node:path'),dotenv:{config(){}}},{process:{env},__dirname:'/test/config'}).config.production.metadata;}
test('new deployments default to paused with small independent run ceilings',()=>{
 const c=config();assert.equal(c.mode,'paused');assert.equal(c.maxArchivesPerRun,20);assert.equal(c.maxRequestsPerRun,80);
});
test('retrying exhausted records is explicit and never opens the whole catalogue',()=>{
 assert.equal(config().retryExhausted,false);
 for(const env of [{METADATA_RETRY_EXHAUSTED:'true'},{METADATA_RETRY_EXHAUSTED:'yes'}])assert.throws(()=>config(env));
 assert.equal(config({METADATA_MODE:'write',METADATA_RETRY_EXHAUSTED:'true',METADATA_ARCHIVE_IDS:'[72368,79353]'}).retryExhausted,true);
});
test('preview cannot accidentally select the whole catalogue; invalid settings fail closed',()=>{
 for(const env of [{METADATA_MODE:'preview'},{METADATA_MODE:'typo'},{METADATA_ARCHIVE_IDS:'1,2'},
  {METADATA_ARCHIVE_IDS:'[1,1]'},{METADATA_ARCHIVE_IDS:'[0]'},{METADATA_ARCHIVE_IDS:'["1"]'},
  {METADATA_MAX_ARCHIVES_PER_RUN:'0'},{METADATA_MAX_REQUESTS_PER_RUN:'Infinity'},
  {METADATA_ARCHIVE_IDS:JSON.stringify(Array.from({length:101},(_,i)=>i+1))}])assert.throws(()=>config(env));
 const c=config({METADATA_MODE:'preview',METADATA_ARCHIVE_IDS:'[3,8]'});assert.equal(c.archiveIds.join(','),'3,8');
});
