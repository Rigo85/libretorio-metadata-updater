const {test}=require('node:test');
const assert=require('node:assert/strict');
const load=require('./loadModule.cjs');
const r=load('helpers/metadataRecovery.ts');
const c=load('helpers/metadataCandidate.ts');
const t=load('helpers/metadataTitle.ts',{'./fileUtils':load('helpers/fileUtils.ts')});
const rows=require('./fixtures/edge-holdout.json');
const plan=row=>r.buildPlan(row,t,c);
const decide=(p,books)=>r.evaluate(p,books,c.selectMetadataCandidate,c.metadataCandidateRejection);

test('placeholder filename is validation-only and needs ISBN, never erases a legitimate Untitled',()=>{
  const row={name:'Smith, John - El camino.pdf',localDetails:{title:'Untitled','author(s)':'John Smith',isbn:'9780306406157'}};
  for(const title of ['Untitled','Untitled-1','Sin título','Sin título 2']){
    const p=plan({...row,localDetails:{...row.localDetails,title}});
    const h=p.hypotheses.find(h=>h.evidence==='placeholder-filename-isbn-only');
    assert.equal(h.title,'El camino');assert.equal(h.validationOnly,true);
    const book={title:'El camino',author_name:['John Smith'],isbn:['9780306406157']};
    assert.ok(decide(p,[book]).match);
    assert.equal(decide(p,[{...book,isbn:[]}]).match,undefined);
    assert.equal(decide(p,[{...book,author_name:['James Smith']}]).match,undefined);
    assert.ok(decide(p,[{title,author_name:['John Smith']}]).match);
    assert.equal(p.tasks.length,7);
  }
  for(const title of ['Untitled poems','Sin titulo para este cuento','Sin titulo 1984'])
    assert.equal(plan({...row,localDetails:{...row.localDetails,title}}).hypotheses.some(h=>h.evidence==='placeholder-filename-isbn-only'),false);
});

test('packed initials match only explicit separate initials and the same surname',()=>{
  const select=(a,b)=>c.selectMetadataCandidate('Example',a,[{title:'Example',author_name:[b]}]);
  for(const [a,b] of [['GP Hudson','G. P. Hudson'],['G. P. Hudson','GP Hudson'],['JRR Tolkien','J. R. R. Tolkien']])assert.ok(select(a,b),a+' / '+b);
  for(const [a,b] of [['GP Hudson','George Paul Hudson'],['GP Hudson','G. R. Hudson'],['GP Hudson','G. P. Smith'],
    ['GP Hudson','G. Hudson'],['Li Hudson','L. I. Hudson'],['GP','G. P.'],['GP HUDSON','G. P. Hudson']])assert.equal(select(a,b),undefined,a+' / '+b);
});

test('placeholder evidence never duplicates an existing filename interpretation',()=>{
  const p=plan({name:'Smith, John - El camino.pdf',localDetails:{title:'Untitled',isbn:'9780306406157'}});
  assert.equal(p.hypotheses.filter(h=>h.title==='El camino'&&h.author==='John Smith').length,1);
});

test('partial field inversion is exploratory, keeps original fields and requires ISBN',()=>{
  const row=structuredClone(rows.find(row=>row.id===92755)),before=JSON.stringify(row);
  const p=plan(row),h=p.hypotheses.find(h=>h.evidence==='possible-partial-field-swap');
  assert.equal(h.title,'Como timbres de alarma');assert.equal(h.author,'Robert Moore Williams');assert.equal(h.queryOnly,true);
  const book={title:h.title,author_name:[h.author]};
  assert.equal(decide(p,[book]).match,undefined);
  assert.equal(JSON.stringify(row),before);
  row.localDetails.isbn='9780306406157';
  assert.ok(decide(plan(row),[{...book,isbn:['9780306406157']}]).match);
  for(const title of ['Robert Another Williams - Como timbres de alarma','Robert Moore Williams - Otro titulo']){
    const altered={...row,localDetails:{...row.localDetails,title}};
    assert.equal(plan(altered).hypotheses.some(h=>h.evidence==='possible-partial-field-swap'),false);
  }
});
