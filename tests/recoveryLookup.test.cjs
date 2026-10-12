const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const load=require('./loadModule.cjs');
const titles=load('helpers/metadataTitle.ts',{'./fileUtils':load('helpers/fileUtils.ts')});
const candidates=load('helpers/metadataCandidate.ts');
const recovery=load('helpers/metadataRecovery.ts');
const frozenPlans=require('./fixtures/recovery-plans.json');
test('40 frozen plans preserve existing alternatives; ambiguous swaps now keep the local pair first',()=>{
  assert.equal(frozenPlans.length,40);
  for(const row of frozenPlans){
    const plan=recovery.buildPlan(row,titles,candidates);
    if([93846,79353].includes(row.id)){
      assert.equal(plan.base.title.reason,'local-title');
      assert.equal(plan.hypotheses.length,2);
      const [local,alternate]=plan.hypotheses;
      assert.equal(local.title,plan.base.title.title);assert.equal(local.author,plan.base.author);
      assert.equal(alternate.evidence,'possible-filename-field-swap');assert.ok(plan.tasks.length<=14);
      // Reconstruct the old plan to prove no previous retrieval alternative was removed.
      plan.hypotheses.shift();alternate.evidence='confirmed-field-swap';
      plan.tasks=plan.tasks.filter(t=>!(t.text===local.title||t.text===`"${local.title}" ${local.author}`));
      for(const task of plan.tasks)if(task.strategy==='possible-filename-field-swap')task.strategy='confirmed-field-swap';
      plan.base={title:{title:alternate.title,source:'filename',reason:'confirmed-field-swap'},
        author:alternate.author,fallbackTitle:alternate.title};
    }
    if([99768,99580].includes(row.id)){
      assert.equal(plan.base.fallbackTitle,plan.base.title.title);
      plan.base.fallbackTitle=titles.resolveFilenameSearch(row.name).title;
    }
    if(row.id===79958){
      const task=plan.tasks.find(task=>task.strategy==='filename-free');
      assert.equal(task.text,'Empires End Aftermath (Chuck Wendig)');
      task.text+=' (z-lib.org)';task.query=task.text;
    }
    let serialized=JSON.stringify(plan);
    if(row.id===132665){
      assert.equal(plan.base.title.title,'1ª fase N3 OMP Resolução EM e PV');
      serialized=serialized.replaceAll(plan.base.title.title,plan.base.title.title+' indd');
    }
    assert.equal(crypto.createHash('sha256').update(serialized).digest('hex'),row.planSha256,String(row.id));
  }
});
function setup(options={}){
  let now=10000,reservations=0,count=0;const calls=[],logs=[];
  class Clock extends Date{static now(){return now;}}
  const tracker={hasKeys:()=>options.keys!==false,getWaitTimeUntilAvailableKeyMs:async()=>0,
    getAvailableKey:async()=>reservations<(options.quota??1000)?'secret-test-key':undefined,
    consumeRequest:async()=>{reservations++;return true;},registerRateLimitHit:async()=>{},markKeyExhausted:async()=>{}};
  const gate={available:()=>count<(options.cap??1000),record:()=>{if(!gate.available())return false;count++;return true;}};
  const modules={
    axios:{async get(url,config){calls.push({url,params:config.params,at:now});return options.respond?options.respond(url,config,calls):{status:200,data:{totalItems:0,docs:[]}};}},
    '(src)/helpers/metadataTitle':titles,'(src)/helpers/metadataCandidate':candidates,'(src)/helpers/metadataRecovery':recovery,
    '(src)/helpers/metadataHttp':load('helpers/metadataHttp.ts'),
    '(src)/services/GoogleBooksService':{GoogleBooksService:{getInstance:()=>({mapToWebDetails:v=>options.mapVolume?options.mapVolume(v):({title:v.title,author_name:v.authors}),extractCoverUrl:v=>v.cover})}},
    '(src)/helpers/logger':{createLogger:()=>({info:(...args)=>logs.push(args),warn:(...args)=>logs.push(args)})}
  };
  const Service=load('services/RecoveryLookupService.ts',modules,{Date:Clock,URL,setTimeout:(fn,ms)=>{now+=ms;fn();}}).RecoveryLookupService;
  const service=new Service(tracker,gate,{requestDelayMs:3000,canUseOpenLibrary:options.ol??false,diagnostics:options.diagnostics});
  const archive={id:1,name:'Known title.pdf',localDetails:{title:'Known title','author(s)':'Test Writer'}};
  return {calls,logs,service,run:()=>service.search(archive),counts:()=>({reservations,count})};
}
test('provenance identifies the chosen Google record without copying injected fields or adding requests',async()=>{
  const data={totalItems:2,items:[
    {id:'wrong-id',volumeInfo:{title:'Unrelated work',authors:['Someone else'],description:'Other book'}},
    {id:'valid_Record-123',volumeInfo:{title:'Known title',authors:['Test Writer'],description:'Useful synopsis',_providerId:'forged'}}]};
  const original=JSON.stringify(data);
  const f=setup({cap:1,mapVolume:v=>({...v,author_name:v.authors}),respond:()=>({status:200,data})});
  const result=await f.run();assert.equal(result.status,'match');
  assert.equal(result.match.webDetails._source,'google-books');assert.equal(result.match.webDetails._providerId,'valid_Record-123');
  assert.equal(result.match.webDetails.description,'Useful synopsis');assert.equal(f.calls.length,1);
  assert.equal(JSON.stringify(data),original);
});
test('OpenLibrary provenance preserves its existing work key without additional requests',async()=>{
  const f=setup({keys:false,ol:true,respond:()=>({status:200,data:{docs:[{key:'/works/OL123W',title:'Known title',
    author_name:['Test Writer'],subject:['Fiction']}]}})});
  const result=await f.run();assert.equal(result.status,'match');assert.equal(f.calls.length,1);
  assert.equal(result.match.webDetails.key,'/works/OL123W');assert.equal(result.match.webDetails._providerId,'/works/OL123W');
  assert.equal(result.match.webDetails._source,'openlibrary');
});
test('missing or malformed Google identifiers are omitted, never truncated into misleading provenance',async()=>{
  for(const id of [undefined,123,'','a'.repeat(121),'https://example.com/?key=secret','bad\nid','valid\n']){
    const f=setup({mapVolume:v=>({...v,author_name:v.authors}),respond:()=>({status:200,data:{totalItems:1,items:[
      {id,volumeInfo:{title:'Known title',authors:['Test Writer'],description:'Useful synopsis',_providerId:'forged'}}]}})});
    const result=await f.run();assert.equal(result.status,'match');assert.equal(f.calls.length,1);
    assert.equal(Object.hasOwn(result.match.webDetails,'_providerId'),false);
  }
});
test('damaged description alone is insufficient with at most two extra HTTP attempts',async()=>{
  const f=setup({mapVolume:v=>({...v,author_name:v.authors}),respond:()=>({status:200,data:{totalItems:1,items:[{
    id:'quality-test',volumeInfo:{title:'Known title',authors:['Test Writer'],description:'Da\uFFFDado'}}]}})});
  const result=await f.run();assert.equal(result.status,'insufficient');assert.equal(result.match,undefined);
  assert.equal(result.errors,0);assert.equal(f.calls.length,3);
  const diagnostic=f.logs.find(([,message])=>message==='Damaged metadata text omitted')[0];
  assert.deepEqual([...diagnostic.discardedTextFields],['description']);assert.equal(diagnostic.candidateKey,'quality-test');
  assert.ok(!JSON.stringify(f.logs).includes('Da\uFFFDado'));
});
test('a useful independent field survives while damaged text is not published',async()=>{
  for(const provider of ['google','ol']){
    const book={title:'Known title',authors:['Test Writer'],author_name:['Test Writer'],description:'Da\uFFFDado',
      first_sentence:['Da\uFFFDado'],subject:['Fiction']};
    const f=setup({keys:provider==='google',ol:provider==='ol',mapVolume:v=>({...v,author_name:v.authors}),
      respond:()=>({status:200,data:provider==='google'?{totalItems:1,items:[{volumeInfo:book}]}:{docs:[book]}})});
    const result=await f.run();assert.equal(result.status,'match');assert.equal(f.calls.length,1);
    assert.equal(result.match.webDetails.description,undefined);assert.equal(result.match.webDetails.first_sentence,undefined);
    assert.deepEqual([...result.match.webDetails.subject],['Fiction']);
  }
});
test('clean description in the same response is preferred without extra requests or field mixing',async()=>{
  const f=setup({mapVolume:v=>({...v,author_name:v.authors}),respond:()=>({status:200,data:{totalItems:2,items:[
    {volumeInfo:{title:'Known title',authors:['Test Writer'],description:'Da\uFFFDado'}},
    {volumeInfo:{title:'Known title',authors:['Test Writer'],description:'Clean description'}}]}})});
  const result=await f.run();assert.equal(result.match.webDetails.description,'Clean description');assert.equal(f.calls.length,1);
});
test('a cover remains useful without treating discarded text as a recovered synopsis',async()=>{
  const f=setup({mapVolume:v=>({...v,author_name:v.authors}),respond:()=>({status:200,data:{totalItems:1,items:[{
    id:'x'.repeat(200),volumeInfo:{title:'Known title',authors:['Test Writer'],description:'Da\uFFFDado',
      cover:'https://books.google.com/cover'}}]}})});
  const result=await f.run();assert.equal(result.status,'match');assert.equal(f.calls.length,1);
  assert.equal(result.match.coverUrl,'https://books.google.com/cover');
  assert.equal(Object.hasOwn(result.match.webDetails,'description'),false);
  assert.equal(f.logs.find(([,message])=>message==='Damaged metadata text omitted')[0].candidateKey.length,120);
});
test('corrupt text does not turn a pending 503 into a spent bibliographic attempt',async()=>{
  const f=setup({mapVolume:v=>({...v,author_name:v.authors}),respond:(_url,_config,calls)=>{
    if(calls.length>1)throw {response:{status:503}};
    return {status:200,data:{totalItems:1,items:[{volumeInfo:{title:'Known title',authors:['Test Writer'],description:'Da\uFFFDado'}}]}};
  }});
  const result=await f.run();assert.equal(result.status,'deferred');assert.equal(result.errors,2);
  assert.equal(result.minimal,true);assert.equal(result.match,undefined);assert.equal(f.calls.length,3);
});
test('success maps metadata, stops alternatives and reserves exactly one request',async()=>{
  const f=setup({respond:()=>({status:200,data:{totalItems:1,items:[{volumeInfo:{title:'Known title',authors:['Test Writer'],cover:'https://books.google.com/cover'}}]}})});
  const result=await f.run();assert.equal(result.status,'match');assert.equal(f.calls.length,1);assert.equal(result.match.coverUrl,'https://books.google.com/cover');
  assert.deepEqual(f.counts(),{reservations:1,count:1});
});
test('lookup returns the storage projection for both providers, never their raw edition payload',async()=>{
  const volume={title:'Known title',authors:['Test Writer'],publisher:['Publisher'],language:['en'],
    isbn:['9780306406157'],first_publish_year:2014,description:'Useful work description'};
  for(const provider of ['google','ol']){
    const f=setup({keys:provider==='google',ol:true,mapVolume:v=>({...v,author_name:v.authors}),
      respond:()=>({status:200,data:provider==='google'?{totalItems:1,items:[{volumeInfo:volume}]}:
        {docs:[{...volume,author_name:volume.authors}]}})});
    const result=await f.run();
    assert.equal(result.status,'match');assert.equal(result.provider,provider);
    assert.equal(result.match.webDetails._metadataScope,'work');
    assert.equal(result.match.webDetails.description,volume.description);
    for(const field of ['isbn','language','publisher','first_publish_year','authors'])
      assert.equal(Object.hasOwn(result.match.webDetails,field),false,field);
    assert.equal(f.calls.length,1);
  }
});
test('four technical attempts per query, no nested provider retries or false no-results',async()=>{
  const f=setup({respond:()=>{throw {response:{status:503}};}});
  const result=await f.run();assert.equal(result.status,'deferred');assert.equal(f.calls.length,12);
  assert.deepEqual(f.counts(),{reservations:12,count:12});assert.equal(result.errors,12);
});
test('quota exhaustion still permits OpenLibrary, but unfinished searches stay deferred',async()=>{
  const f=setup({quota:0,ol:true});assert.equal((await f.run()).status,'deferred');assert.ok(f.calls.every(r=>r.url.includes('openlibrary')));
  const success=setup({quota:0,ol:true,respond:()=>({status:200,data:{docs:[{title:'Known title',author_name:['Test Writer']}]}})});
  assert.equal((await success.run()).status,'deferred');assert.equal(success.counts().reservations,0);
});
test('timeouts retry, per-run cap blocks later calls, Retry-After blocks all queries of provider',async()=>{
  const f=setup({cap:2,respond:()=>{throw {code:'ERR_CANCELED',response:{headers:{'retry-after':'120'}}};}});
  assert.equal((await f.run()).status,'deferred');assert.equal(f.calls.length,2);assert.ok(f.calls[1].at-f.calls[0].at>=120000);
});
test('nonretryable and malformed responses defer; log never includes API key',async()=>{
  for(const respond of [()=>{throw {response:{status:400}};},()=>({status:200,data:{totalItems:1}})]){
    const f=setup({respond});assert.equal((await f.run()).status,'deferred');assert.equal(f.calls.length,3);
    assert.ok(!JSON.stringify(f.logs).includes('secret-test-key'));
  }
});
test('complete no-results differs from rejected candidates and unsafe cover URLs are not fetched',async()=>{
  const none=setup();assert.equal((await none.run()).status,'none');
  const rejected=setup({respond:()=>({status:200,data:{totalItems:1,items:[{volumeInfo:{title:'Other title',authors:['Test Writer']}}]}})});
  assert.equal((await rejected.run()).status,'rejected');
  const match=setup({respond:()=>({status:200,data:{totalItems:1,items:[{volumeInfo:{title:'Known title',authors:['Test Writer'],cover:'http://localhost/secret'}}]}})});
  assert.equal((await match.run()).status,'insufficient');
});

test('candidate diagnostics are opt-in, bounded, identify Google items and explain rejections',async()=>{
  const respond=()=>({status:200,data:{totalItems:20,items:Array.from({length:20},(_,i)=>({id:'id-'+i,volumeInfo:{
    title:'Unrelated '.repeat(100),authors:Array.from({length:10},()=> 'A'.repeat(1000)),description:'private-response-body'
  }}))}});
  for(const diagnostics of [false,true]){
    const f=setup({diagnostics,respond});assert.equal((await f.run()).status,'rejected');
    const rows=f.logs.filter(([,message])=>message==='Metadata HTTP result').map(([row])=>row);
    for(const row of rows){
      assert.ok(row.reviewReasons.includes('title-mismatch'));
      assert.equal(row.strategy!==undefined,true);
      if(!diagnostics){assert.equal(row.candidates,undefined);continue;}
      assert.equal(row.candidates.length,5);
      assert.equal(row.candidates[0].key,'id-0');
      for(const candidate of row.candidates){
        assert.ok(candidate.title.length<=200);assert.ok(candidate.authors.length<=5);
        assert.ok(candidate.authors.every(name=>name.length<=100));assert.equal(candidate.truncated,true);
        assert.equal(candidate.accepted,false);assert.ok(candidate.reasons.includes('title-mismatch'));
      }
    }
    assert.ok(!JSON.stringify(f.logs).includes('secret-test-key'));
    assert.ok(!JSON.stringify(f.logs).includes('private-response-body'));
  }
});

test('technical failure identifies query and strategy without leaking request configuration',async()=>{
  const f=setup({cap:1,respond:()=>{throw {response:{status:503},config:{key:'secret-test-key'}};}});
  assert.equal((await f.run()).status,'deferred');
  const row=f.logs.find(([,message])=>message==='Metadata HTTP failure')[0];
  assert.ok(row.query.includes('Known title'));assert.equal(row.strategy,'local-title');
  assert.equal(row.retryable,true);assert.equal(row.config,undefined);
});

test('one malformed entry cannot hide another valid book in the same provider response',async()=>{
  for(const provider of ['google','ol']){
    const f=setup({keys:provider==='google',ol:provider==='ol',diagnostics:true,respond:()=>({status:200,data:provider==='google'?
      {totalItems:2,items:[null,{volumeInfo:{title:'Known title',authors:['Test Writer'],cover:'https://books.google.com/cover'}}]}:
      {docs:[null,{title:'Known title',author_name:['Test Writer'],description:'Useful description'}]}})});
    const result=await f.run();
    assert.equal(result.status,'match',provider);
    assert.equal(result.match.webDetails.title,'Known title');
    assert.equal(f.calls.length,1);
    assert.ok(f.logs.some(([,message])=>message==='Metadata response contains invalid candidates'));
  }
});

test('partial malformed results without a valid match remain deferred, not a book failure',async()=>{
  for(const malformed of [null,{title:'Known title',author_name:'Test Writer'},
    {title:'Known title',author_name:['Test Writer'],isbn:'9780306406157'}]){
    const f=setup({keys:false,ol:true,diagnostics:true,respond:()=>({status:200,data:{docs:[malformed,{title:'Unrelated'}]}})});
    const result=await f.run();
    assert.equal(result.status,'deferred');
    assert.ok(result.errors>0);
    assert.equal(f.calls.length,2);
  }
});

test('lookup passes local language into the storage projection without losing the matched work',async()=>{
  const f=setup({mapVolume:v=>({...v,author_name:v.authors}),respond:()=>({status:200,data:{totalItems:1,items:[{volumeInfo:{
    title:'Known title',authors:['Test Writer'],isbn:['9780306406157'],language:['en'],publisher:['Other edition']
  }}]}})});
  const result=await f.service.search({id:1,name:'Known title.pdf',localDetails:{title:'Known title','author(s)':'Test Writer',
    isbn:'9780306406157',languages:'spa'}});
  assert.equal(result.status,'insufficient');assert.equal(result.match,undefined);
  assert.equal(result.minimal,true);assert.equal(f.calls.length,3);
});

test('a minimal match can improve, with at most two extra HTTP attempts and no field mixing',async()=>{
  const f=setup({mapVolume:v=>({...v,author_name:v.authors}),respond:(_url,_config,calls)=>({status:200,data:{totalItems:1,items:[{volumeInfo:{
    title:'Known title',authors:['Test Writer'],...(calls.length===2?{description:'Useful description'}:{})
  }}]}})});
  const result=await f.run();assert.equal(result.match.webDetails.description,'Useful description');assert.equal(f.calls.length,2);
  const failing=setup({respond:(_url,_config,calls)=>{if(calls.length>1)throw {response:{status:503}};
    return {status:200,data:{totalItems:1,items:[{volumeInfo:{title:'Known title',authors:['Test Writer']}}]}};}});
  const fallback=await failing.run();assert.equal(fallback.status,'deferred');assert.equal(fallback.match,undefined);
  assert.equal(fallback.minimal,true);assert.equal(fallback.errors,2);assert.equal(failing.calls.length,3);
  const completion=failing.logs.find(([,message])=>message==='Minimal metadata not publishable')[0];
  assert.equal(completion.reason,'enrichment-budget');assert.equal(completion.enrichmentRequests,2);
});

test('run quota preserves diagnostic evidence but cannot publish minimal metadata',async()=>{
  const f=setup({cap:1,respond:()=>({status:200,data:{totalItems:1,items:[{volumeInfo:{title:'Known title',authors:['Test Writer']}}]}})});
  const result=await f.run();assert.equal(result.status,'deferred');assert.equal(result.minimal,true);
  assert.equal(result.match,undefined);assert.equal(result.limited,true);assert.equal(f.calls.length,1);
});

test('richness is assessed after projection and can prefer a compatible entry in the same response',async()=>{
  const f=setup({mapVolume:v=>({...v,author_name:v.authors}),respond:()=>({status:200,data:{totalItems:2,items:[
    {volumeInfo:{title:'Known title',authors:['Test Writer'],publisher:['Other edition'],isbn:['9780306406157']}},
    {volumeInfo:{title:'Known title',authors:['Test Writer'],description:'Description'}}
  ]}})});
  const result=await f.run();assert.equal(result.match.webDetails.description,'Description');assert.equal(result.match.webDetails.publisher,undefined);
  assert.equal(f.calls.length,1);
});

test('an enrichment candidate cannot replace the retained match with another author identity',async()=>{
  const f=setup({mapVolume:v=>({...v,author_name:v.authors}),respond:(_url,_config,calls)=>({status:200,data:{totalItems:1,items:[{volumeInfo:{
    title:'Known title',authors:[calls.length===1?'Test Writer':'Test Other Writer'],...(calls.length>1?{description:'Different credit'}:{})
  }}]}})});
  const result=await f.run();assert.equal(result.status,'insufficient');assert.equal(result.match,undefined);
  assert.ok(f.logs.some(([,message])=>message==='Enrichment rejected: different retained identity'));
  assert.equal(f.calls.length,3);
});

test('minimal metadata with successful bounded enrichment is insufficient, not a match or technical failure',async()=>{
  const f=setup({ol:true,respond:()=>({status:200,data:{totalItems:1,items:[{volumeInfo:{title:'Known title',authors:['Test Writer']}}],
    docs:[{title:'Known title',author_name:['Test Writer']}]}})});
  const result=await f.run();
  assert.equal(result.status,'insufficient');assert.equal(result.minimal,true);assert.equal(result.match,undefined);
  assert.equal(result.errors,0);assert.equal(result.limited,false);assert.equal(f.calls.length,3);
});
test('a recovered HTTP error does not defer minimal metadata indefinitely',async()=>{
  const f=setup({keys:false,ol:true,respond:(_url,_config,calls)=>{
    if(calls.length===1)throw {response:{status:503}};
    return {status:200,data:{docs:[{title:'Known title',author_name:['Test Writer']}]}};
  }});
  const result=await f.run();assert.equal(result.status,'insufficient');assert.equal(result.errors,1);
  assert.equal(result.match,undefined);assert.equal(f.calls.length,3);
});
test('partial malformed responses cannot turn minimal metadata into a bibliographic failure',async()=>{
  const f=setup({respond:()=>({status:200,data:{totalItems:2,items:[null,{volumeInfo:{title:'Known title',authors:['Test Writer']}}]}})});
  const result=await f.run();assert.equal(result.status,'deferred');assert.equal(result.minimal,true);
  assert.equal(result.match,undefined);assert.equal(result.errors,3);assert.equal(f.calls.length,3);
});

test('useful metadata cannot override ambiguous identities in one response',async()=>{
  const f=setup({mapVolume:v=>({...v,author_name:v.authors}),respond:()=>({status:200,data:{totalItems:2,items:[
    {volumeInfo:{title:'Known title',authors:['Test Writer']}},
    {volumeInfo:{title:'Known title',authors:['Test Other Writer'],description:'Useful but ambiguous'}}
  ]}})});
  assert.equal((await f.run()).status,'rejected');
});

const swapped={id:77642,name:'Mark Clifton y Frank Riley La maquina de la eternidad Premio Hugo 1955.epub',
  localDetails:{title:'M. Clifton y F. Riley','author(s)':'La m\u00e1quina de la eternidad [La m\u00e1quina de la eternidad]',isbn:'84-666-0864-8'}};
test('actual lookup preserves identity-only correction on insufficient/deferred outcomes and includes it with useful web data',async()=>{
  for(const status of ['insufficient','deferred','match']){
    const f=setup({mapVolume:v=>({...v,author_name:v.authors}),respond:(_url,_config,calls)=>{
      if(calls.length>1&&status==='deferred')throw {response:{status:503}};
      return {status:200,data:{totalItems:1,items:[{id:'NeH4PQAACAAJ',volumeInfo:{title:'La M\u00e1quina de la eternidad',
        authors:['Mark Clifton','Frank Riley'],isbn:['9788466608640'],...(status==='match'?{description:'Useful'}:{})}}]}};
    }});
    const result=await f.service.search(swapped);
    assert.equal(result.status,status);assert.equal(result.localCorrection.author,'Mark Clifton & Frank Riley');
    assert.equal(result.localCorrection.providerId,'NeH4PQAACAAJ');
    assert.equal(result.localCorrection.before.title,swapped.localDetails.title);
    assert.equal(!!result.match,status==='match');assert.equal(f.calls.length,status==='match'?1:3);
  }
});
test('an exact filename swap without a Google confirmation remains untouched on no results or an outage',async()=>{
  const archive={id:3,name:'Shaw, Bob - El palacio de la eternidad.pdf',
    localDetails:{title:'Shaw, Bob','author(s)':'El palacio de la eternidad'}};
  for(const failure of [false,true]){
    const f=setup({respond:()=>{if(failure)throw {response:{status:503}};return {status:200,data:{totalItems:0}};}});
    const result=await f.service.search(archive);
    assert.equal(result.status,failure?'deferred':'none');assert.equal(result.match,undefined);
    assert.equal(result.localCorrection,undefined);
  }
});
test('a useful OpenLibrary match with an inversion stays pending when Google is unavailable',async()=>{
  const f=setup({keys:false,ol:true,respond:()=>({status:200,data:{docs:[{title:'La m\u00e1quina de la eternidad',
    author_name:['Mark Clifton','Frank Riley'],isbn:['9788466608640'],description:'Useful description',key:'/works/OL123W'}]}})});
  const result=await f.service.search(swapped);assert.equal(result.status,'deferred');assert.equal(result.provider,'ol');
  assert.equal(result.localCorrection,undefined);assert.equal(result.match,undefined);assert.equal(result.identityUnverified,true);
});

const swappedVolume={title:'La M\u00e1quina de la eternidad',authors:['Mark Clifton','Frank Riley'],isbn:['9788466608640']};
const googleResponse=(volume,id='NeH4PQAACAAJ')=>({status:200,data:{totalItems:1,items:[{id,volumeInfo:volume}]}});
test('useful OpenLibrary metadata and later minimal Google evidence are returned together without mixing web fields',async()=>{
  const f=setup({ol:true,mapVolume:v=>({...v,author_name:v.authors}),respond:(url,_config,calls)=>{
    if(url.includes('openlibrary'))return {status:200,data:{docs:[{key:'/works/OL123W',title:swappedVolume.title,
      author_name:swappedVolume.authors,isbn:swappedVolume.isbn,description:'OL synopsis'}]}};
    if(!calls.some(call=>call.url.includes('openlibrary')))throw {response:{status:503}};
    return googleResponse(swappedVolume);
  }});
  const result=await f.service.search(swapped);
  assert.equal(result.status,'match');assert.equal(result.provider,'ol');
  assert.equal(result.match.webDetails._providerId,'/works/OL123W');assert.equal(result.match.webDetails.description,'OL synopsis');
  assert.equal(result.localCorrection.providerId,'NeH4PQAACAAJ');assert.equal(result.localCorrection.author,'Mark Clifton & Frank Riley');
  const firstOl=f.calls.findIndex(call=>call.url.includes('openlibrary'));
  assert.equal(f.calls.length-firstOl-1,1);assert.ok(result.errors>0);assert.ok(f.calls.length<=56);
});
test('useful Google metadata without matching ISBN waits for verification instead of closing the row',async()=>{
  const f=setup({mapVolume:v=>({...v,author_name:v.authors}),respond:(_url,_config,calls)=>googleResponse(
    calls.length===1?{title:'El palacio de la eternidad',authors:['Bob Shaw'],description:'Rich edition'}:
      {title:'El palacio de la eternidad',authors:['Bob Shaw'],isbn:['9780306406157']},calls.length===1?'rich':'verified')});
  const result=await f.service.search({id:7,name:'Shaw, Bob - El palacio de la eternidad.pdf',
    localDetails:{title:'Shaw, Bob','author(s)':'El palacio de la eternidad',isbn:'9780306406157'}});
  assert.equal(result.status,'match');assert.equal(result.match.webDetails._providerId,'rich');
  assert.equal(result.localCorrection.providerId,'verified');assert.equal(f.calls.length,2);
});
test('a minimal Google entry in the same response can confirm the useful entry without another HTTP request',async()=>{
  const f=setup({mapVolume:v=>({...v,author_name:v.authors}),respond:()=>({status:200,data:{totalItems:2,items:[
    {id:'rich',volumeInfo:{title:'El palacio de la eternidad',authors:['Bob Shaw'],description:'Rich edition'}},
    {id:'verified',volumeInfo:{title:'El palacio de la eternidad',authors:['Bob Shaw'],isbn:['9780306406157']}}
  ]}})});
  const result=await f.service.search({id:7,name:'Shaw, Bob - El palacio de la eternidad.pdf',
    localDetails:{title:'Shaw, Bob','author(s)':'El palacio de la eternidad',isbn:'9780306406157'}});
  assert.equal(result.status,'match');assert.equal(result.match.webDetails._providerId,'rich');
  assert.equal(result.localCorrection.providerId,'verified');assert.equal(f.calls.length,1);
});
test('verification keeps the two-request cap, run quota, identity guard and no unverified publication',async()=>{
  for(const mode of ['503','homonym','quota','invalid-id']){
    const f=setup({cap:mode==='quota'?1:100,mapVolume:v=>({...v,author_name:v.authors}),respond:(_url,_config,calls)=>{
      if(calls.length===1)return googleResponse({...swappedVolume,description:'Useful'},'bad/id');
      if(mode==='503')throw {response:{status:503}};
      if(mode==='invalid-id')return googleResponse(swappedVolume,'bad/id');
      return googleResponse({...swappedVolume,authors:['Jose Maria Paz Gago']});
    }});
    const result=await f.service.search(swapped);
    assert.equal(result.status,['503','quota'].includes(mode)?'deferred':'insufficient');assert.equal(result.identityUnverified,true);
    assert.equal(result.match,undefined);assert.equal(result.localCorrection,undefined);
    assert.equal(result.minimal,undefined);assert.equal(f.calls.length,mode==='quota'?1:3);
    assert.deepEqual(f.counts(),{reservations:f.calls.length,count:f.calls.length});
  }
});
test('fully completed Google checks without confirmation consume bibliographic rather than technical retries',async()=>{
  const f=setup({ol:true,mapVolume:v=>({...v,author_name:v.authors}),respond:(url)=>url.includes('google')?
    {status:200,data:{totalItems:0}}:{status:200,data:{docs:[{key:'/works/OL123W',title:'El palacio de la eternidad',
      author_name:['Bob Shaw'],description:'Useful but cannot verify local inversion'}]}}});
  const result=await f.service.search({id:3,name:'Shaw, Bob - El palacio de la eternidad.pdf',
    localDetails:{title:'Shaw, Bob','author(s)':'El palacio de la eternidad'}});
  assert.equal(result.status,'insufficient');assert.equal(result.identityUnverified,true);
  assert.equal(result.errors,0);assert.equal(result.match,undefined);assert.equal(result.localCorrection,undefined);
});

test('a comma title retains its useful local identity; conflicting interpretations in one response are rejected',async()=>{
  const title='Orgullo, Prejuicio',author='Jane Austen';
  const archive={id:10,name:`${title} - ${author}.pdf`,localDetails:{title,'author(s)':author}};
  const plan=recovery.buildPlan(archive,titles,candidates);
  assert.equal(plan.base.author,author);assert.equal(plan.hypotheses[0].evidence,'local-title');
  assert.ok(plan.tasks.length<=14);
  for(const ambiguous of [false,true]){
    const f=setup({mapVolume:v=>({...v,author_name:v.authors}),respond:()=>({status:200,data:{
      totalItems:ambiguous?2:1,items:[{id:'normal',volumeInfo:{title,authors:[author],description:'Useful title'}},
        ...(ambiguous?[{id:'conflict',volumeInfo:{title:author,authors:['Prejuicio Orgullo'],description:'Other identity'}}]:[])]
    }})});
    const result=await f.service.search(archive);
    assert.equal(result.status,ambiguous?'rejected':'match');
    assert.equal(result.localCorrection,undefined);assert.equal(result.identityUnverified,undefined);
    if(!ambiguous){assert.equal(f.calls.length,1);assert.equal(result.match.webDetails.title,title);}
  }
});
test('a correct title-only hit is reachable through bounded coauthor fallback, without accepting a rich homonym',async()=>{
  const f=setup({ol:true,mapVolume:v=>({...v,author_name:v.authors}),respond:(url,config)=>({status:200,data:url.includes('google')?
    {totalItems:config.params.q==='"La m\u00e1quina de la eternidad"'?1:0,
      ...(config.params.q==='"La m\u00e1quina de la eternidad"'?{items:[{id:'NeH4PQAACAAJ',volumeInfo:{title:'La M\u00e1quina de la eternidad',
        authors:['Mark Clifton','Frank Riley'],isbn:['9788466608640']}}]}:{})}:
    {docs:[{title:'La m\u00e1quina de la eternidad',author_name:['Jose Maria Paz Gago'],isbn:['9788418966644'],cover_i:13673412}]}})});
  const result=await f.service.search(swapped);
  assert.equal(result.status,'insufficient');assert.equal(result.match,undefined);assert.equal(result.localCorrection.providerId,'NeH4PQAACAAJ');
  assert.ok(f.calls.length<=14);assert.ok(f.calls.some(call=>call.params.q==='"La m\u00e1quina de la eternidad"'));
});
