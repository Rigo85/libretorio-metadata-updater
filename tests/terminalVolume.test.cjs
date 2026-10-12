const {test}=require('node:test'),assert=require('node:assert/strict');
const load=require('./loadModule.cjs');
const authors=load('helpers/metadataCandidate.ts'),recovery=load('helpers/metadataRecovery.ts');
const titles=load('helpers/metadataTitle.ts',{'./fileUtils':load('helpers/fileUtils.ts')});
test('terminal volume labels normalize explicit integer volumes, not significant words or fractions',()=>{
  for(const label of ['Vol. 2','vol 02','volumen 2','volume II','tomo II']){
    assert.equal(authors.terminalVolumeVariant('Terra Nova '+label),'Terra Nova 2');
    assert.equal(authors.metadataCandidateRejection('Terra Nova '+label,undefined,{title:'Terra Nova 2'}),undefined);
    assert.equal(authors.metadataCandidateRejection('Terra Nova 2',undefined,{title:'Terra Nova '+label}),undefined);
  }
  for(const title of ['Terra Nova','Malcolm X','Terra Nova Vol 0','Terra Nova Vol 2.5','Terra Nova Vol 2 subtitulo',
    'Terra Nova Vol IIII','Terra Nova parte 2','Terra Nova libro 2','Terra Nova Vol 999999999999999999'])
    assert.equal(authors.terminalVolumeVariant(title),undefined,title);
  for(const title of ['Terra Nova','Terra Nova 1','Terra Nova 3','Terra Nova 2 3'])
    assert.equal(authors.metadataCandidateRejection('Terra Nova Vol. 2',undefined,{title}),'volume-mismatch');
});
test('normalizing volume labels never supplies missing identity evidence or overrides conflicting authors',()=>{
  const source={name:'Terra Nova 2.epub',localDetails:{title:'Terra Nova Vol. 2','author(s)':'VV. AA.'}};
  const plan=recovery.buildPlan(source,titles,authors),book={title:'Terra Nova 2',author_name:['Varios autores']};
  const result=recovery.evaluate(plan,[book],authors.selectMetadataCandidate,authors.metadataCandidateRejection);
  assert.equal(result.match,undefined);assert.ok(result.review.some(r=>r.reason==='title-only-no-author-evidence'));
  assert.equal(authors.metadataCandidateRejection('Terra Nova Vol. 2','Test Writer',{...book,author_name:['Unrelated Writer']}),'author-mismatch');
  assert.equal(authors.metadataCandidateRejection('No hay salida Vol. 2',undefined,{title:'Hay salida 2'}),'title-mismatch');
});
test('volume retrieval adds only two supplemental queries and retains all original hypotheses and source data',()=>{
  const source={name:'Terra Nova 2.epub',localDetails:{title:'Terra Nova Vol. 2','author(s)':'VV. AA.'}};
  const before=JSON.stringify(source),plan=recovery.buildPlan(source,titles,authors);
  const variant=plan.tasks.filter(t=>t.strategy==='terminal-volume-label');
  assert.equal(variant.length,2);assert.ok(plan.tasks.length<=14);
  assert.deepEqual(Array.from(variant,t=>t.query),['intitle:"Terra Nova 2"','"Terra Nova 2"']);
  assert.equal(plan.hypotheses.length,1);assert.equal(plan.hypotheses[0].title,'Terra Nova Vol 2');
  assert.equal(JSON.stringify(source),before);
  assert.equal(recovery.buildPlan({name:'Malcolm X.epub',localDetails:{title:'Malcolm X'}},titles,authors).tasks
    .filter(t=>t.strategy==='terminal-volume-label').length,0);
});
test('captured Terra Nova candidate remains unpublishable without independent local identity evidence',()=>{
  const source={name:'Terra Nova 2.epub',localDetails:{title:'Terra Nova Vol. 2','author(s)':'VV. AA.'}};
  const book={title:'Terra Nova 2',author_name:['Varios autores'],isbn:['9788415831280','8415831285']};
  const evaluate=archive=>recovery.evaluate(recovery.buildPlan(archive,titles,authors),[book],
    authors.selectMetadataCandidate,authors.metadataCandidateRejection);
  assert.equal(evaluate(source).match,undefined);
  // Synthetic positive control, not an ISBN supplied by the real local sample.
  assert.equal(evaluate({...source,localDetails:{...source.localDetails,isbn:'9788415831280'}}).match,book);
  assert.equal(evaluate({...source,localDetails:{...source.localDetails,isbn:'9780306406157'}}).match,undefined);
});
