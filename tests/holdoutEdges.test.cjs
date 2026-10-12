const {test}=require('node:test');
const assert=require('node:assert/strict');
const load=require('./loadModule.cjs');
const r=load('helpers/metadataRecovery.ts');
const c=load('helpers/metadataCandidate.ts');
const t=load('helpers/metadataTitle.ts',{'./fileUtils':load('helpers/fileUtils.ts')});
const rows=require('./fixtures/edge-holdout.json');
const source=id=>structuredClone(rows.find(row=>row.id===id));
const plan=row=>r.buildPlan(row,t,c);
const decide=(p,books)=>r.evaluate(p,books,c.selectMetadataCandidate,c.metadataCandidateRejection);

test('all twenty unseen sources build bounded plans without modifying their source data',()=>{
  assert.equal(rows.length,20);
  const before=JSON.stringify(rows);
  for(const row of rows){
    const p=plan(row);
    assert.ok(p.tasks.length<=14);assert.ok(p.hypotheses.length<=6);
    assert.equal(new Set(p.tasks.map(q=>JSON.stringify([q.provider,q.query,q.author,q.provider==='openlibrary'?q.general:null]))).size,p.tasks.length);
  }
  assert.equal(JSON.stringify(rows),before);
});

// Candidate responses below are synthetic counterexamples, not observed provider matches.
test('explicit local series adds only two bounded short-title queries and still requires ISBN and author',()=>{
  const row=source(73368),p=plan(row);
  const candidate={title:'Impávido',author_name:['Jack Campbell'],isbn:['9788498005684']};
  assert.ok(decide(p,[candidate]).match);
  assert.equal(p.tasks.length,9);
  assert.equal(p.tasks.filter(q=>q.strategy==='series-short-title').length,2);
  assert.ok(p.tasks.slice(-2).every(q=>q.text==='Impávido'&&q.author==='Jack Campbell'&&!q.general));
  for(const changed of [{...candidate,isbn:[]},{...candidate,isbn:['9780140328721']},
    {...candidate,title:'Otro libro'},{...candidate,author_name:['Otra Persona']}])
    assert.equal(decide(p,[changed]).match,undefined);
  row.localDetails.series='La Flota Perdida #3';
  assert.equal(decide(plan(row),[candidate]).match,undefined);
  assert.equal(plan(row).tasks.some(q=>q.strategy==='series-short-title'),false);
  delete row.localDetails.series;
  assert.equal(decide(plan(row),[candidate]).match,undefined);
});

test('an exact ISBN cannot certify edition fields against a contradictory local language',()=>{
  const row=source(71539),p=plan(row);
  const candidate={title:'Aguantar el cielo',author_name:['Cixin Liu'],isbn:p.isbns,
    language:['en'],publisher:['Example publisher'],first_publish_year:2020,description:'Work description'};
  const match=decide(p,[candidate]).match;assert.ok(match);
  const stored=r.metadataForStorage(p,match,'google',row.localDetails);
  assert.equal(stored._metadataScope,'work');
  for(const field of ['isbn','publisher','language','first_publish_year'])assert.equal(stored[field],undefined);
  assert.equal(stored.description,candidate.description);
  for(const language of ['es','spa','es-PE'])
    assert.equal(r.metadataForStorage(p,{...candidate,language:[language]},'google',row.localDetails)._metadataScope,'edition');
  assert.equal(r.metadataForStorage(p,candidate,'google',JSON.stringify(row.localDetails))._metadataScope,'work');
});

test('fractional series positions cannot match a different reordered position',()=>{
  const p=plan(source(139877));
  assert.equal(decide(p,[{title:'Crónicas de Pike 5.12 Invencible',author_name:['GP Hudson']}]).match,undefined);
  assert.ok(decide(p,[{title:'Crónicas de Pike 12.5 Invencible',author_name:['GP Hudson']}]).match);
});

test('missing negation cannot be erased by otherwise similar title tokens',()=>{
  assert.equal(c.selectMetadataCandidate('El hombre que no queria morir','John Smith',[
    {title:'El hombre que queria morir',author_name:['John Smith']}
  ]),undefined);
  assert.ok(c.selectMetadataCandidate('El hombre que no queria morir','John Smith',[
    {title:'El hombre que no quería morir',author_name:['John Smith']}
  ]));
});
