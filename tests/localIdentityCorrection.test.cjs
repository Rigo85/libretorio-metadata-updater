const {test}=require('node:test'),assert=require('node:assert/strict');
const load=require('./loadModule.cjs');
const authors=load('helpers/metadataCandidate.ts'),recovery=load('helpers/metadataRecovery.ts');
const titles=load('helpers/metadataTitle.ts',{'./fileUtils':load('helpers/fileUtils.ts')});
const source={name:'Mark Clifton y Frank Riley La maquina de la eternidad Premio Hugo 1955.epub',
  localDetails:{title:'M. Clifton y F. Riley','author(s)':'La m\u00e1quina de la eternidad [La m\u00e1quina de la eternidad]',identifiers:'isbn:84-666-0864-8'}};
const book={title:'La M\u00e1quina de la eternidad',author_name:['Mark Clifton','Frank Riley'],isbn:['9788466608640']};
const provenance={provider:'google',providerId:'NeH4PQAACAAJ'};
const repair=(row,candidate)=>recovery.localIdentityCorrection(recovery.buildPlan(row,titles,authors),row,authors,candidate,provenance);
const explicit={name:'Shaw, Bob - El palacio de la eternidad.pdf',
  localDetails:{title:'Shaw, Bob','author(s)':'El palacio de la eternidad [El palacio de la eternidad]',comments:'Preserved',publisher:'Local'}};

test('even an exact filename inversion requires a verified Google identity, never local data alone',()=>{
  assert.equal(repair(explicit),undefined);
  // Synthetic checksum-valid ISBN checks the gate, not the real edition of this fixture.
  const row={...explicit,localDetails:{...explicit.localDetails,isbn:'9780306406157'}};
  const candidate={title:'El palacio de la eternidad',author_name:['Bob Shaw'],isbn:['9780306406157']};
  const frozen=JSON.stringify(row),fix=repair(row,candidate);
  assert.equal(fix.title,candidate.title);assert.equal(fix.author,'Bob Shaw');
  assert.equal(fix.evidence,'google-isbn-confirmed-field-swap');
  assert.equal(fix.before.title,'Shaw, Bob');assert.equal(fix.before.author,explicit.localDetails['author(s)']);
  assert.equal(fix.provider,'google');assert.equal(JSON.stringify(row),frozen);
  assert.equal(repair({...row,localDetails:JSON.stringify(row.localDetails)},candidate).title,fix.title);
  assert.equal(repair(row),undefined);assert.equal(repair(explicit,candidate),undefined);
  assert.equal(repair(row,{...candidate,author_name:['Another Writer']}),undefined);
});
test('Google identity-only and useful results make the same independently evidenced local repair',()=>{
  const frozen=JSON.stringify(source);
  for(const candidate of [book,{...book,description:'Useful synopsis',subject:['Fiction']}]){
    const fix=repair(source,candidate);
    assert.equal(fix.title,book.title);assert.equal(fix.author,'Mark Clifton & Frank Riley');
    assert.equal(fix.evidence,'google-isbn-confirmed-field-swap');assert.equal(fix.isbn,'9788466608640');
    assert.equal(fix.providerId,'NeH4PQAACAAJ');assert.equal(fix.before.title,source.localDetails.title);
    assert.equal(fix.before.author,source.localDetails['author(s)']);
    assert.equal(Object.hasOwn(fix,'description'),false);
  }
  assert.equal(JSON.stringify(source),frozen);assert.equal(repair(source),undefined);
});
test('repair needs all corroborated people, exact title and local ISBN, not just retrieval similarity',()=>{
  for(const change of [{isbn:[]},{isbn:['9780306406157']},{author_name:['Mark Clifton']},
    {author_name:['Mark Clifton','Fred Riley']},{author_name:['Mark Clifton','Frank Riley','Another Writer']},
    {author_name:['Mark Clifton','Mark Clifton']},{title:book.title+' 2'},
    {title:book.title+' relatos'},{title:'Otra novela'},{author_name:['Mark Clifton','Frank Ri\uFFFDley']}])
    assert.equal(repair(source,{...book,...change}),undefined,JSON.stringify(change));
  assert.equal(repair({...source,name:source.name.replace('Frank Riley','William Riley')},book),undefined);
});
test('manual, already corrected, malformed or merely disagreeing sources are never repaired',()=>{
  assert.equal(repair({...source,customDetails:true},book),undefined);
  for(const localDetails of [null,[],42,'broken',{}, {...source.localDetails,_identityCorrection:null},
    {...source.localDetails,title:'An unrelated title'},{...source.localDetails,'author(s)':'Unknown'}])
    assert.equal(repair({...source,localDetails},book),undefined);
  const fix=repair(source,book);
  assert.equal(repair({...source,localDetails:{...source.localDetails,title:fix.title,'author(s)':fix.author,_identityCorrection:fix}},book),undefined);
  assert.equal(repair({...explicit,localDetails:{...explicit.localDetails,'author(s)':'La eternidad del palacio'}}),undefined);
  assert.equal(repair({...explicit,localDetails:{title:'El palacio de la eternidad','author(s)':'Bob Shaw'}}),undefined);
});
test('non-swap search variants never authorize local metadata rewriting',()=>{
  const row={name:'Hiroshi Sakurazaka Al filo del manana nominada al premio Seioun.epub',
    localDetails:{title:'Al filo del manana nominada al premio Seioun','author(s)':'Hiroshi Sakurazaka',identifiers:'isbn:9781421542447'}};
  assert.equal(repair(row,{title:'Al filo del manana',author_name:['Hiroshi Sakurazaka'],isbn:['9781421542447']}),undefined);
});
test('a real title containing commas is not a person; ambiguous shared-surname coauthors remain unchanged',()=>{
  const title='El gran libro de los ba\u00f1os, riegos y despojos',author='Luisa de la Cruz Zambrana';
  const row={name:title+' - '+author+'.pdf',localDetails:{title,'author(s)':author}};
  // The search resolver alone is not sufficient authority to rewrite metadata.
  const plan=recovery.buildPlan(row,titles,authors);
  assert.equal(plan.base.title.reason,'local-title');
  assert.equal(plan.base.author,author);
  assert.equal(plan.hypotheses.length,1);
  assert.equal(plan.hypotheses[0].author,author);
  assert.ok(plan.tasks.every(task=>task.author===undefined||task.author===author));
  assert.equal(repair(row),undefined);
  assert.equal(repair(row,{title,author_name:[author],isbn:['9780306406157']}),undefined);
  for(const prefix of ['Strugatski, Arkadi y Boris','El Gran Libro, Del Mundo','Un, Autor']){
    const row={name:prefix+' - Una novela.pdf',localDetails:{title:prefix,'author(s)':'Una novela'}};
    assert.equal(repair(row),undefined);
  }
});
test('OpenLibrary, missing Google record IDs and filename evidence cannot authorize a repair',()=>{
  const plan=recovery.buildPlan(source,titles,authors);
  for(const provenance of [undefined,{provider:'ol',providerId:'/works/OL123W'},
    {provider:'google'},{provider:'google',providerId:'https://example.com'}])
    assert.equal(recovery.localIdentityCorrection(plan,source,authors,book,provenance),undefined);
});
test('coauthor title-only retrieval keeps ISBN/author admission and existing query bounds',()=>{
  const plan=recovery.buildPlan(source,titles,authors),tasks=plan.tasks.filter(t=>t.strategy==='coauthor-swap-isbn-only');
  assert.equal(tasks.length,2);assert.ok(plan.tasks.length<=14);
  assert.equal(tasks[0].query,'"La m\u00e1quina de la eternidad"');assert.equal(tasks[0].general,true);
  assert.equal(tasks[1].general,false);assert.ok(tasks.every(t=>t.author===undefined));
  const h=plan.hypotheses.find(h=>h.evidence==='coauthor-swap-isbn-only');
  assert.equal(h.author,'mark clifton & frank riley');assert.equal(h.queryOnly,true);
});
