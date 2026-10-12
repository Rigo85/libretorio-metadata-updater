const {test}=require('node:test');
const assert=require('node:assert/strict');
const load=require('./loadModule.cjs');
const recovery=load('helpers/metadataRecovery.ts');
const candidates=load('helpers/metadataCandidate.ts');
const titles=load('helpers/metadataTitle.ts',{'./fileUtils':load('helpers/fileUtils.ts')});
const source={name:'Known title.epub',localDetails:{title:'Known title','author(s)':'Test Writer',isbn:'9780306406157',languages:'spa'}};

test('damaged descriptive fields are omitted after projection without mutating either input',()=>{
  const candidate={title:'Known title',author_name:['Test Writer'],description:'Coraz\uFFFDn',
    first_sentence:['Good first sentence','Da\uFFFDado'],subject:['Fiction'],publisher:['Publisher'],
    isbn:['9780306406157'],language:['es']};
  const original=JSON.stringify({source,candidate});
  for(const provider of ['google','ol']){
    const projected=recovery.metadataForStorage(recovery.buildPlan(source,titles,candidates),candidate,provider,source.localDetails);
    assert.equal(Object.hasOwn(projected,'description'),false);
    assert.equal(Object.hasOwn(projected,'first_sentence'),false);
    assert.equal(projected.title,candidate.title);assert.deepEqual([...projected.subject],['Fiction']);
    assert.equal(projected._metadataScope,provider==='google'?'edition':'work');
  }
  assert.equal(JSON.stringify({source,candidate}),original);
});
test('valid Unicode and absent text are preserved; only literal replacement characters are flagged',()=>{
  const description='Espa\u00F1ol, acci\u00F3n, M\u00FCller, \u65E5\u672C\u8A9E, \uD83D\uDCDA';
  const candidate={title:'Known title',author_name:['Test Writer'],description,first_sentence:['\u00BFQu\u00E9 tal?']};
  const plan=recovery.buildPlan(source,titles,candidates);
  const projected=recovery.metadataForStorage(plan,candidate,'google',source.localDetails);
  assert.equal(projected.description,description);assert.deepEqual([...projected.first_sentence],candidate.first_sentence);
  assert.deepEqual([...recovery.damagedMetadataTextFields(candidate)],[]);
  assert.deepEqual([...recovery.damagedMetadataTextFields({title:'Known title'})],[]);
  assert.deepEqual([...recovery.damagedMetadataTextFields({...candidate,description:'a\uFFFDb'})],['description']);
});
test('collective author variants are ignored, not converted into identity evidence',()=>{
  for(const author of ['VV. AA.','VVAA','VV AA','VV. AA. [AA., VV.]','AA. VV.','AAVV']){
    assert.equal(candidates.resolveMetadataAuthor({'author(s)':author}),undefined,author);
    const local={name:'Terra Nova 2.epub',localDetails:{title:'Terra Nova Vol. 2','author(s)':author}};
    const plan=recovery.buildPlan(local,titles,candidates);
    assert.ok(plan.tasks.every(task=>!task.author));assert.ok(plan.tasks.length<=14);
    const result=recovery.evaluate(plan,[{title:'Terra Nova Vol. 2',author_name:['Unrelated Writer']}],
      candidates.selectMetadataCandidate,candidates.metadataCandidateRejection);
    assert.equal(result.match,undefined);assert.ok(result.review.some(r=>r.reason==='title-only-no-author-evidence'));
  }
  for(const author of ['V. A. Smith','A. A. Attanasio','VV. AA. [Editor real]'])
    assert.equal(candidates.resolveMetadataAuthor({'author(s)':author}),author);
});
