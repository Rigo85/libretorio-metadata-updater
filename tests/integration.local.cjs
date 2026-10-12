// Only for the two disposable containers documented in ops/2026-10-10-metadata.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {Client} = require('pg');
const {createClient} = require('redis');
const moment = require('moment-timezone');
const load = require('./loadModule.cjs');
const logger = {info() {}, warn() {}, error() {}};

test('PostgreSQL: keyset, preserved metadata, concurrent edits and capped attempts', async t => {
  const db = new Client('postgres://postgres:local-validation@127.0.0.1:15439/metadata_validation');
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query('CREATE TABLE archive (id INTEGER PRIMARY KEY, name TEXT, "coverId" TEXT, "localDetails" JSONB, "webDetails" JSONB, "customDetails" BOOLEAN DEFAULT false)');
    const mocks = {'(src)/db/PostgresAdapter': {PostgresAdapter: {getInstance: () => ({query: async (...args) => (await db.query(...args)).rows})}}};
    const repo = load('repositories/ArchiveRepository.ts', mocks).ArchiveRepository.getInstance();
    const control = load('repositories/MetadataLookupControlRepository.ts', mocks).MetadataLookupControlRepository.getInstance();
    // Test actual DDL in this disposable DB; rollback also removes both tables.
    await control.ensureTable();
    await db.query(`INSERT INTO archive (id, name, "localDetails", "webDetails", "customDetails") VALUES
      (1,'New','{"title":"Local"}',NULL,false), (2,'Web','{}','{"title":"Existing"}',false),
      (3,'Manual','{}',NULL,true), (4,'Exhausted','{}',NULL,false), (5,'Later','{}',NULL,false),
      (6,'Empty web object','{}','{}',false), (7,'Deleted','{}',NULL,false)`);
    await db.query('INSERT INTO metadata_lookup_control (archive_id,attempts) VALUES (4,3)');
    await t.test('pagination excludes exhausted/manual/populated including empty JSON', async () => {
      assert.deepEqual((await repo.getArchivesNeedingMetadata(3,1,0)).map(row => row.id), [1]);
      assert.deepEqual((await repo.getArchivesNeedingMetadata(3,2,1)).map(row => row.id), [5,7]);
    });
    await t.test('writes never overwrite existing/manual metadata', async () => {
      assert.deepEqual((await repo.getArchivesNeedingMetadata(3,50,0,{ids:[2,3,4,5,6],includeExhausted:true})).map(r=>r.id),[4,5]);
      assert.deepEqual((await repo.getArchivesNeedingMetadata(3,50,0,{ids:[4,5],includeExhausted:false})).map(r=>r.id),[5]);
      await assert.rejects(repo.getArchivesNeedingMetadata(3,50,0,{ids:[],includeExhausted:true}),/requires IDs/);
      for (const id of [2,3,6]) assert.equal(await repo.updateWebDetails(id, '{"title":"Bad"}'), false);
      assert.equal(await repo.updateWebDetails(1, '{"title":"New web"}'), true);
      assert.equal(await repo.updateWebDetails(1, '{"title":"Overwrite"}'), false);
      const row = (await db.query('SELECT "localDetails", "webDetails" FROM archive WHERE id=1')).rows[0];
      assert.deepEqual(row.localDetails, {title:'Local'});
      assert.deepEqual(row.webDetails, {title:'New web'});
    });
    await t.test('attempt count ignores changed/deleted/exhausted and never exceeds max', async () => {
      await db.query('DELETE FROM archive WHERE id=7');
      for (const id of [1,2,3,4,6,7]) assert.equal(await control.incrementAttempts(id,3), undefined);
      for (const expected of [1,2,3,undefined]) assert.equal(await control.incrementAttempts(5,3), expected);
      assert.deepEqual(await repo.getArchivesNeedingMetadata(3,50,0), []);
    });
    await t.test('SQL errors propagate instead of pretending there are no pending archives', async () => {
      await db.query('SAVEPOINT expected_failure');
      await db.query('DROP TABLE metadata_lookup_control');
      await assert.rejects(repo.getArchivesNeedingMetadata(3,50,0), /does not exist/);
      await db.query('ROLLBACK TO SAVEPOINT expected_failure');
    });
    await t.test('changed local source blocks both metadata publication and bibliographic attempts',async()=>{
      await db.query(`INSERT INTO archive(id,name,"coverId","localDetails") VALUES(8,'Original','cover','{"title":"Original"}')`);
      const selected=(await repo.getArchivesNeedingMetadata(3,10,0)).find(r=>r.id===8);
      assert.ok(selected.sourceFingerprint);
      await db.query(`UPDATE archive SET "localDetails"='{"title":"Replaced"}' WHERE id=8`);
      assert.equal(await repo.updateWebDetails(8,'{"title":"Stale"}',selected.sourceFingerprint),false);
      assert.equal(await control.incrementAttempts(8,3,selected.sourceFingerprint),undefined);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM metadata_lookup_control WHERE archive_id=8')).rows[0].n,0);
    });
    await t.test('work and edition projections with provenance persist without changing local data or leaking foreign edition search fields',async()=>{
      const recovery=load('helpers/metadataRecovery.ts');
      const authors=load('helpers/metadataCandidate.ts');
      const titles=load('helpers/metadataTitle.ts',{'./fileUtils':load('helpers/fileUtils.ts')});
      const candidate={title:'Example',author_name:['John Smith'],description:'Description of the work',
        isbn:['9780306406157'],language:['en'],publisher:['Foreign edition'],first_publish_year:2014};
      for(const id of [9,10,11]){
        const localDetails={title:'Example','author(s)':'John Smith',languages:id===10?'eng':'spa',
          ...(id!==9?{identifiers:'isbn:9780306406157'}:{})};
        await db.query('INSERT INTO archive(id,name,"localDetails") VALUES($1,$2,$3)',[id,'Example.pdf',localDetails]);
        const archive=(await repo.getArchivesNeedingMetadata(3,10,0,{ids:[id]}))[0];
        const plan=recovery.buildPlan(archive,titles,authors);
        const decision=recovery.evaluate(plan,[candidate],authors.selectMetadataCandidate,authors.metadataCandidateRejection);
        assert.ok(decision.match);
        const projected=recovery.metadataForStorage(plan,decision.match,'google',archive.localDetails);
        projected._providerId='record_'+id;
        assert.equal(await repo.updateWebDetails(id,JSON.stringify(projected),archive.sourceFingerprint),true);
        assert.equal(await repo.updateWebDetails(id,'{"title":"Overwrite"}',archive.sourceFingerprint),false);
        const stored=(await db.query(`SELECT "localDetails","webDetails",
          "webDetails"->>'isbn' AS isbn,"webDetails"->>'language' AS language FROM archive WHERE id=$1`,[id])).rows[0];
        assert.deepEqual(stored.localDetails,localDetails);
        assert.equal(stored.webDetails._metadataScope,id===10?'edition':'work');
        assert.equal(stored.webDetails.description,candidate.description);
        assert.equal(stored.webDetails._providerId,'record_'+id);
        assert.equal(stored.webDetails._source,'google-books');
        if(id!==10){assert.equal(stored.isbn,null);assert.equal(stored.language,null);}
        else{assert.deepEqual(stored.webDetails.isbn,candidate.isbn);assert.deepEqual(stored.webDetails.language,candidate.language);}
        assert.equal((await db.query('SELECT count(*)::int AS n FROM metadata_lookup_control WHERE archive_id=$1',[id])).rows[0].n,0);
      }
    });
    await t.test('updater minimal policy: three attempts, deferred errors unchanged, existing metadata preserved',async()=>{
      const local={title:'Known title','author(s)':'Test Writer'};
      for(const id of [12,13,14,15])await db.query('INSERT INTO archive(id,name,"localDetails","webDetails","customDetails") VALUES($1,$2,$3,$4,$5)',
        [id,'Known title.pdf',local,id===14?{title:'Existing minimal'}:null,id===15]);
      const lookups=[],summaries=[];
      const titles=load('helpers/metadataTitle.ts',{'./fileUtils':load('helpers/fileUtils.ts')});
      const Service=load('services/MetadataUpdaterService.ts',{
        '(src)/config/configuration':{config:{production:{metadata:{mode:'write',archiveIds:[12,13,14,15],
          maxAttempts:3,maxArchivesPerRun:4,maxRequestsPerRun:80,batchSize:2,googleApiKeys:['fake'],
          dailyRequestLimit:1000,requestSafetyBufferPerKey:100,requestDelayMs:0,canUseOpenLibrary:true}}}},
        '(src)/repositories/ArchiveRepository':{ArchiveRepository:{getInstance:()=>repo}},
        '(src)/repositories/MetadataLookupControlRepository':{MetadataLookupControlRepository:{getInstance:()=>control}},
        '(src)/services/MetadataRunState':{MetadataRunState:class{afterId=0;async open(){}async close(){}async advance(){}}},
        '(src)/services/RecoveryLookupService':{RecoveryLookupService:class{async search(archive){
          lookups.push(archive.id);return {status:archive.id===12?'insufficient':'deferred',minimal:true,
            rejected:false,errors:archive.id===12?0:1,limited:false};
        }}},
        '(src)/services/RequestTracker':{RequestTracker:class{hasKeys(){return true;}async getUsageSummary(){return [];}}},
        '(src)/services/CoverService':{CoverService:{getInstance(){throw Error('No minimal cover download allowed');}}},
        '(src)/helpers/metadataTitle':titles,'(src)/helpers/metadataCandidate':load('helpers/metadataCandidate.ts'),
        '(src)/helpers/logger':{createLogger:()=>({...logger,info(data,message){if(message==='=== Metadata update summary ===')summaries.push(data);}})}
      }).MetadataUpdaterService;
      const service=Service.getInstance();
      for(let i=0;i<4;i++)await service.runUpdate();
      assert.deepEqual(lookups,[12,13,12,13,12,13,13]);
      assert.ok(summaries.every(row=>row.completed));
      assert.deepEqual(summaries.map(row=>row.insufficientAttempts),[1,1,1,0]);
      assert.deepEqual(summaries.map(row=>row.deferred),[1,1,1,1]);
      assert.deepEqual((await db.query('SELECT archive_id,attempts FROM metadata_lookup_control WHERE archive_id>=12 ORDER BY archive_id')).rows,
        [{archive_id:12,attempts:3}]);
      const rows=(await db.query('SELECT id,"localDetails","webDetails","customDetails" FROM archive WHERE id>=12 ORDER BY id')).rows;
      for(const row of rows){
        assert.deepEqual(row.localDetails,local);
        assert.deepEqual(row.webDetails,row.id===14?{title:'Existing minimal'}:null);
        assert.equal(row.customDetails,row.id===15);
      }
    });
    await t.test('local identity correction is guarded, reversible and atomic with useful web metadata',async()=>{
      const original={title:'M. Clifton y F. Riley','author(s)':'La maquina de la eternidad [La maquina de la eternidad]',
        identifiers:'isbn:84-666-0864-8',comments:'Original local description',publisher:'Original publisher',languages:'spa'};
      const correction={title:'La maquina de la eternidad',author:'Mark Clifton & Frank Riley',
        before:{title:original.title,author:original['author(s)']},sourceName:'Original.epub',
        evidence:'google-isbn-confirmed-field-swap',isbn:'9788466608640',provider:'google',providerId:'NeH4PQAACAAJ'};
      for(let id=20;id<=29;id++)await db.query('INSERT INTO archive(id,name,"localDetails") VALUES($1,$2,$3)',[id,'Original.epub',original]);
      const read=id=>repo.getArchivesNeedingMetadata(3,1,0,{ids:[id]}).then(rows=>rows[0]);
      const selected=await read(20);
      for(const invalid of [{...correction,provider:'ol'},{...correction,providerId:undefined},
        {...correction,evidence:'filename-confirmed-field-swap'}]){
        await assert.rejects(repo.updateLocalIdentity(20,invalid,selected.sourceFingerprint),/verified Google/);
        await assert.rejects(repo.updateWebDetails(20,'{}',selected.sourceFingerprint,invalid),/verified Google/);
      }
      assert.equal(await repo.updateLocalIdentity(20,correction,undefined),undefined);
      assert.equal(await repo.updateWebDetails(20,'{}',undefined,correction),false);
      const next=await repo.updateLocalIdentity(20,correction,selected.sourceFingerprint);
      assert.ok(next);assert.notEqual(next,selected.sourceFingerprint);
      assert.equal(await control.incrementAttempts(20,3,selected.sourceFingerprint),undefined);
      assert.equal(await control.incrementAttempts(20,3,next),1);
      const saved=(await db.query('SELECT "localDetails","webDetails" FROM archive WHERE id=20')).rows[0];
      assert.equal(saved.webDetails,null);assert.equal(saved.localDetails.title,correction.title);
      assert.equal(saved.localDetails['author(s)'],correction.author);
      for(const field of ['identifiers','comments','publisher','languages'])assert.equal(saved.localDetails[field],original[field]);
      assert.deepEqual(saved.localDetails._identityCorrection.before,correction.before);
      assert.equal(saved.localDetails._identityCorrection.providerId,'NeH4PQAACAAJ');
      assert.ok(Date.parse(saved.localDetails._identityCorrection.correctedAt));
      assert.equal(await repo.updateLocalIdentity(20,correction,next),undefined);
      const row21=await read(21),web=JSON.stringify({title:correction.title,description:'Useful web description'});
      assert.equal(await repo.updateWebDetails(21,web,row21.sourceFingerprint,correction),true);
      const both=(await db.query('SELECT "localDetails","webDetails" FROM archive WHERE id=21')).rows[0];
      assert.equal(both.localDetails.title,correction.title);assert.equal(both.webDetails.description,'Useful web description');
      assert.equal(await control.incrementAttempts(21,3),undefined);
      // Each intervention occurs after the updater's read but before its guarded save.
      const races=[
        ['UPDATE archive SET "customDetails"=true WHERE id=$1',[]],
        ['UPDATE archive SET "webDetails"=$2 WHERE id=$1',[{title:'Saved elsewhere'}]],
        ['UPDATE archive SET "localDetails"=$2 WHERE id=$1',[{...original,title:'Manually changed local'}]],
        ['UPDATE archive SET name=$2 WHERE id=$1',['Renamed.epub']],
        ['UPDATE archive SET "coverId"=$2 WHERE id=$1',['new-source']],
        ['DELETE FROM archive WHERE id=$1',[]]
      ];
      for(let i=0;i<races.length;i++){
        const id=22+i,previous=await read(id),[sql,args]=races[i];await db.query(sql,[id,...args]);
        const snapshot=JSON.stringify((await db.query('SELECT * FROM archive WHERE id=$1',[id])).rows);
        assert.equal(await repo.updateLocalIdentity(id,correction,previous.sourceFingerprint),undefined);
        assert.equal(await repo.updateWebDetails(id,web,previous.sourceFingerprint,correction),false);
        assert.equal(JSON.stringify((await db.query('SELECT * FROM archive WHERE id=$1',[id])).rows),snapshot);
      }
      await db.query('UPDATE archive SET "localDetails"=$1 WHERE id=28',[{...original,_identityCorrection:{version:1}}]);
      assert.equal(await repo.updateWebDetails(28,web,(await read(28)).sourceFingerprint,correction),false);
      assert.equal((await db.query('SELECT "webDetails" FROM archive WHERE id=28')).rows[0].webDetails,null);
      await db.query('UPDATE archive SET "localDetails"=$1 WHERE id=29',[JSON.stringify('not-an-object')]);
      assert.equal(await repo.updateLocalIdentity(29,correction,(await read(29)).sourceFingerprint),undefined);
      // Reversibility does not require a new table or a backup of the whole JSON payload.
      const restored={...saved.localDetails,title:saved.localDetails._identityCorrection.before.title,
        'author(s)':saved.localDetails._identityCorrection.before.author};delete restored._identityCorrection;
      assert.deepEqual(restored,original);
    });
    await t.test('real lookup and updater: verify before publishing, repeat safely and retain technical retries',async()=>{
      const titles=load('helpers/metadataTitle.ts',{'./fileUtils':load('helpers/fileUtils.ts')});
      const candidates=load('helpers/metadataCandidate.ts'),recovery=load('helpers/metadataRecovery.ts');
      const title='El palacio de la eternidad',author='Bob Shaw';
      for(const [index,mode] of ['confirm','503','no-proof','comma'].entries()){
        const id=40+index,calls=[],summaries=[];
        const local=mode==='comma'?{title:'El gran libro de los ba\u00f1os, riegos y despojos','author(s)':'Luisa de la Cruz Zambrana'}:
          {title:'Shaw, Bob','author(s)':title,isbn:'9780306406157',comments:'Preserved'};
        const name=mode==='comma'?local.title+' - '+local['author(s)']+'.pdf':'Shaw, Bob - '+title+'.pdf';
        await db.query('INSERT INTO archive(id,name,"localDetails") VALUES($1,$2,$3)',[id,name,local]);
        let now=10000,olSeen=false;
        class Clock extends Date{static now(){return now;}}
        class Tracker{
          hasKeys(){return true;}async getWaitTimeUntilAvailableKeyMs(){return 0;}
          async getAvailableKey(){return 'test-key';}async consumeRequest(){return true;}
          async getUsageSummary(){return [];}
        }
        const Lookup=load('services/RecoveryLookupService.ts',{
          axios:{async get(url,config){
            calls.push({url,params:config.params});
            if(url.includes('openlibrary')){olSeen=true;return {status:200,data:{docs:[{
              key:'/works/OL123W',title,author_name:[author],isbn:['9780306406157'],description:'Useful OL synopsis'
            }]}};}
            if(mode==='503'||(mode==='confirm'&&!olSeen))throw {response:{status:503}};
            if(mode==='no-proof')return {status:200,data:{totalItems:0}};
            return {status:200,data:{totalItems:1,items:[{id:'verified',volumeInfo:mode==='comma'?
              {title:local.title,author_name:[local['author(s)']],description:'Useful comma title'}:
              {title,author_name:[author],isbn:['9780306406157']}}]}};
          }},
          '(src)/helpers/metadataTitle':titles,'(src)/helpers/metadataCandidate':candidates,
          '(src)/helpers/metadataRecovery':recovery,'(src)/helpers/metadataHttp':load('helpers/metadataHttp.ts'),
          '(src)/services/GoogleBooksService':{GoogleBooksService:{getInstance:()=>({mapToWebDetails:v=>v,extractCoverUrl:()=>undefined})}},
          '(src)/helpers/logger':{createLogger:()=>logger}
        },{Date:Clock,URL,setTimeout:(fn,ms)=>{now+=ms;fn();}}).RecoveryLookupService;
        const Service=load('services/MetadataUpdaterService.ts',{
          '(src)/config/configuration':{config:{production:{metadata:{mode:'write',archiveIds:[id],maxAttempts:3,
            maxArchivesPerRun:1,maxRequestsPerRun:56,batchSize:1,googleApiKeys:['test-key'],dailyRequestLimit:1000,
            requestSafetyBufferPerKey:100,requestDelayMs:3000,canUseOpenLibrary:true}}}},
          '(src)/repositories/ArchiveRepository':{ArchiveRepository:{getInstance:()=>repo}},
          '(src)/repositories/MetadataLookupControlRepository':{MetadataLookupControlRepository:{getInstance:()=>control}},
          '(src)/services/MetadataRunState':{MetadataRunState:class{afterId=0;async open(){}async close(){}async advance(){}}},
          '(src)/services/RecoveryLookupService':{RecoveryLookupService:Lookup},
          '(src)/services/RequestTracker':{RequestTracker:Tracker},
          '(src)/services/CoverService':{CoverService:{getInstance(){throw Error('Unexpected cover download');}}},
          '(src)/helpers/metadataTitle':titles,'(src)/helpers/metadataCandidate':candidates,
          '(src)/helpers/logger':{createLogger:()=>({...logger,info(data,message){
            if(message==='=== Metadata update summary ===')summaries.push(data);
          }})}
        }).MetadataUpdaterService;
        const service=Service.getInstance();await service.runUpdate();
        const first=(await db.query('SELECT "localDetails","webDetails" FROM archive WHERE id=$1',[id])).rows[0];
        const initialCalls=calls.length;
        for(let repeat=0;repeat<3;repeat++)await service.runUpdate();
        assert.ok(summaries.every(row=>row.completed),mode);
        const last=(await db.query('SELECT "localDetails","webDetails" FROM archive WHERE id=$1',[id])).rows[0];
        assert.deepEqual(last,first);
        const attempts=(await db.query('SELECT attempts FROM metadata_lookup_control WHERE archive_id=$1',[id])).rows;
        if(mode==='confirm'){
          assert.equal(first.localDetails.title,title);assert.equal(first.localDetails['author(s)'],author);
          assert.equal(first.localDetails.comments,'Preserved');assert.equal(first.localDetails._identityCorrection.providerId,'verified');
          assert.equal(first.webDetails.description,'Useful OL synopsis');assert.equal(first.webDetails._providerId,'/works/OL123W');
          assert.equal(calls.length,initialCalls);assert.deepEqual(attempts,[]);
        }else if(mode==='comma'){
          assert.deepEqual(first.localDetails,local);assert.equal(first.webDetails.title,local.title);
          assert.equal(calls.length,1);assert.deepEqual(attempts,[]);
        }else{
          assert.deepEqual(first.localDetails,local);assert.equal(first.webDetails,null);
          assert.deepEqual(attempts,mode==='503'?[]:[{attempts:3}]);
          assert.equal(summaries[0].identityUnverified,1);
          assert.equal(summaries[0].deferred,mode==='503'?1:0);
        }
      }
    });
  } finally {
    await db.query('ROLLBACK');
    await db.end();
  }
});

test('durable traversal with real Redis and PostgreSQL session lock, including restart and corrupted state',async()=>{
  const redis=createClient({url:'redis://127.0.0.1:16389',disableOfflineQueue:true});await redis.connect();
  const {Pool}=require('pg');
  const adapters=Array.from({length:2},()=>load('db/PostgresAdapter.ts',{
    pg:{Pool},'(src)/config/configuration':{config:{production:{db:{databaseUrl:'postgres://postgres:local-validation@127.0.0.1:15439/metadata_validation'}}}},
    '(src)/helpers/logger':{createLogger:()=>logger}
  }).PostgresAdapter);
  const states=adapters.map(Adapter=>load('services/MetadataRunState.ts',{
    '(src)/db/PostgresAdapter':{PostgresAdapter:Adapter},'(src)/db/RedisAdapter':{getClient:()=>redis}
  }).MetadataRunState);
  const key='meta-updater:catalogue-cursor:v1';
  const first=new states[0](true),other=new states[1](true);
  try{
    await redis.del(key);await first.open();assert.equal(first.afterId,0);
    await assert.rejects(other.open(),/holds the lock/);
    await first.advance(40);await first.close();
    await other.open();assert.equal(other.afterId,40);await other.close();
    await redis.set(key,'bad');await assert.rejects(first.open(),/Invalid metadata cursor/);
    await redis.set(key,'50');await other.open();assert.equal(other.afterId,50);await other.close();
    const selected=new states[0](false);await selected.open();assert.equal(selected.afterId,0);await selected.advance(2);await selected.close();
    assert.equal(await redis.get(key),'50');
  }finally{
    await first.close();await other.close();await redis.del(key);await redis.quit();
    for(const Adapter of adapters)await Adapter.getInstance().disconnect();
  }
});

test('Redis: real Lua reservation, persisted usage, cooldown, outages and Pacific DST', async t => {
  const client = createClient({url:'redis://127.0.0.1:16389', disableOfflineQueue:true});
  client.on('error', () => {});
  await client.connect();
  let current = client;
  const Tracker = load('services/RequestTracker.ts', {
    '(src)/db/RedisAdapter': {getClient: () => current},
    '(src)/helpers/logger': {createLogger: () => logger}, 'moment-timezone': moment
  }).RequestTracker;
  const key = 'TESTMETA-key';
  const tracker = new Tracker([key], 10, 2);
  const counter = tracker.buildRedisKey(key);
  try {
    await t.test('existing counter remains; 20 simultaneous reservations cannot exceed 8', async () => {
      await client.set(counter, '5');
      const reserved = await Promise.all(Array.from({length:20}, () => tracker.consumeRequest(key)));
      assert.equal(reserved.filter(Boolean).length, 3);
      assert.equal(await client.get(counter), '8');
      assert.equal(await tracker.getAvailableKey(), undefined);
      assert.equal(await tracker.getEffectiveLimit(), 0);
      assert.ok(await client.ttl(counter) > 0);
    });
    await t.test('malformed counter and missing Redis fail closed', async () => {
      await client.set(counter, 'invalid');
      await assert.rejects(tracker.consumeRequest(key), /Invalid usage counter/);
      await assert.rejects(tracker.getEffectiveLimit(), /Invalid Google usage/);
      current = undefined;
      await assert.rejects(tracker.consumeRequest(key), /Redis unavailable/);
      current = client;
    });
    await t.test('cooldown blocks reservations; exhausted counter persists across a new tracker', async () => {
      await client.set(counter, '0');
      assert.equal(await tracker.registerRateLimitHit(key), 30);
      assert.equal(await tracker.consumeRequest(key), false);
      await tracker.markKeyExhausted(key, 'test');
      assert.equal(await new Tracker([key], 10, 2).getEffectiveLimit(), 0);
      assert.equal(await client.get(counter), '10');
    });
    await t.test('same eight-character prefix does not double-count remaining budget', async () => {
      const shared = new Tracker(['PREFIX01-a','PREFIX01-b'], 10, 2);
      assert.equal(await shared.getEffectiveLimit(), 8);
    });
    await t.test('invalid config fails before any request', () => {
      for (const [limit,buffer] of [[NaN,0],[10,10],[10,-1],[10.5,1]]) assert.throws(() => new Tracker([key],limit,buffer));
    });
    await t.test('midnight TTL follows 23h/25h DST days', () => {
      const original = moment.now;
      try {
        moment.now = () => Date.parse('2026-03-08T08:00:00Z');
        assert.equal(tracker.secondsUntilPacificMidnight(), 23*3600);
        moment.now = () => Date.parse('2026-11-01T07:00:00Z');
        assert.equal(tracker.secondsUntilPacificMidnight(), 25*3600);
      } finally { moment.now = original; }
    });
  } finally {
    for (const prefix of ['meta-updater:usage','meta-updater:rate-limit','meta-updater:cooldown']) {
      await client.del(`${prefix}:${key.slice(0,8)}:${tracker.getPacificDateString()}`);
    }
    await client.quit();
  }
});
