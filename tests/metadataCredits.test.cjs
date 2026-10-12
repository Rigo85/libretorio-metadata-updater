const {test}=require('node:test');
const assert=require('node:assert/strict');
const load=require('./loadModule.cjs');
const c=load('helpers/metadataCandidate.ts');
const t=load('helpers/metadataTitle.ts',{'./fileUtils':load('helpers/fileUtils.ts')});
const r=load('helpers/metadataRecovery.ts');
const reject=(author,authors)=>c.metadataCandidateRejection('Example',author,{title:'Example',author_name:authors});
const plan=(localDetails,name='file.pdf')=>r.buildPlan({name,localDetails},t,c);
const decide=(p,candidate)=>r.evaluate(p,[candidate],c.selectMetadataCandidate,c.metadataCandidateRejection);

test('redundant bracket repeats one complete explicit coauthor, not an unrelated credit',()=>{
  const source={'author(s)':'Brian Herbert & Kevin J. Anderson [Herbert, Brian]'};
  assert.equal(c.resolveMetadataAuthor(source),'Brian Herbert & Kevin J. Anderson');
  assert.equal(source['author(s)'],'Brian Herbert & Kevin J. Anderson [Herbert, Brian]');
  for(const suffix of ['[Herbert]','[Frank Herbert]','[Editor Brian Herbert]','[Brian Herbert Jr.]']){
    const value='Brian Herbert & Kevin J. Anderson '+suffix;
    assert.equal(c.resolveMetadataAuthor({'author(s)':value}),value);
  }
  const author=c.resolveMetadataAuthor(source);
  assert.equal(reject(author,['Brian Herbert','Kevin J. Anderson']),undefined);
  assert.equal(reject(author,['Brian Herbert']),'author-mismatch');
  assert.equal(reject(author,['Kevin J. Anderson']),'author-mismatch');
});

test('comma-separated full credits require every individually corroborated author',()=>{
  const authors=['Graciela Ferrarini','Gustavo Massaccesi','Laura Pezzatti','Ana Wykowski'];
  const author='Graciela Ferrarini, Gustavo Massaccesi, Laura Pezzatti y Ana Wykowski';
  assert.equal(reject(author,authors),undefined);
  assert.equal(reject(author,[...authors].reverse()),undefined);
  for(let i=0;i<authors.length;i++){
    assert.equal(reject(author,authors.filter((_,index)=>index!==i)),'author-mismatch');
    assert.equal(reject(author,authors.map((value,index)=>index===i?'Unrelated Writer':value)),'author-mismatch');
  }
  assert.equal(reject(author,['Graciela Ferrarini Gustavo Massaccesi Laura Pezzatti',authors[3]]),'author-mismatch');
  assert.equal(reject('John Smith, Jane Doe',['John Smith Jane Doe']),'author-mismatch');
  assert.equal(reject('John Smith, J. Smith, Jane Doe',['John Smith','Jane Doe']),'author-mismatch');
  assert.equal(reject('John Smith, John Smith, Jane Doe',['John Smith','Jane Doe']),'author-mismatch');
});

test('surname-first, compound names and initials retain established interpretations',()=>{
  for(const [query,authors] of [
    ['Garcia Marquez, Gabriel',['Gabriel Garcia Marquez']],
    ['Garcia Marquez, Gabriel Jose',['Gabriel Jose Garcia Marquez']],
    ['Attanasio, Alfred A',['A. A. Attanasio']],
    ['Herbert, Brian & Anderson, Kevin J.',['Brian Herbert','Kevin J. Anderson']],
    ['Jose Ortega y Gasset',['Jose Ortega y Gasset']],
    ['John Smith, Jane Doe',['J. Smith','Jane Doe']]
  ])assert.equal(reject(query,authors),undefined,query);
  for(const [query,authors] of [
    ['Smith, John',['Smith','John']],
    ['Smith, John, Doe, Jane',['John Smith','Jane Doe']],
    ['John Smith, Jane Doe',['James Smith','Jane Doe']],
    ['John Smith, Jane Doe',['J. Jones','Jane Doe']]
  ])assert.equal(reject(query,authors),'author-mismatch',query);
});

test('new comma fallback is bounded and does not rewrite local fields',()=>{
  const names=Array.from({length:9},(_,i)=>`Author${String.fromCharCode(65+i)} Surname${String.fromCharCode(65+i)}`);
  assert.equal(reject(names.join(', '),names),'author-mismatch');
  assert.equal(reject('John Smith, Jane Doe',['John Smith','Jane Doe',...Array(15).fill('Other Writer')]),'author-mismatch');
  const local={title:'Example','author(s)':'John Smith, Jane Doe'};
  const p=plan(local),candidate={title:'Example',author_name:['John Smith','Jane Doe']};
  assert.ok(decide(p,candidate).match);
  assert.deepEqual(local,{title:'Example','author(s)':'John Smith, Jane Doe'});
});

test('only explicit format-plus-copy markers generate a title variant',()=>{
  assert.equal(t.fileCopyTitleVariant('MYTHS MERMAIDS.pdf \u00b7 versi\u00f3n 1.pdf'),'MYTHS MERMAIDS');
  assert.equal(t.fileCopyTitleVariant('Example 2.epub \u00b7 copia 3'),'Example 2');
  for(const title of ['Version 1','Example version 1','1984','COVID 19','108 Problemas Semanales 2018',
    'Example 2','Example.pdf','Example.pdf version 1','Example.pdf \u00b7 version 1 revised'])
    assert.equal(t.fileCopyTitleVariant(title),undefined,title);
});

test('copy-marker retrieval preserves the original query and requires independent ISBN',()=>{
  const local={title:'MYTHS MERMAIDS.pdf \u00b7 versi\u00f3n 1','author(s)':'Unknown'};
  const p=plan(local,'MYTHS MERMAIDS.pdf \u00b7 versi\u00f3n 1.pdf');
  assert.equal(p.hypotheses[0].title,'MYTHS MERMAIDS pdf versi\u00f3n 1');
  assert.equal(p.tasks.filter(task=>task.strategy==='file-copy-marker').length,2);
  assert.ok(p.tasks.some(task=>task.text===p.hypotheses[0].title));
  assert.ok(p.tasks.length<=14);assert.ok(p.hypotheses.length<=6);
  const candidate={title:'MYTHS MERMAIDS',author_name:['Jane Doe']};
  assert.equal(decide(p,candidate).match,undefined);
  assert.equal(decide(p,{...candidate,isbn:['9780306406157']}).match,undefined);
  const withIsbn=plan({...local,isbn:'9780306406157'});
  assert.ok(decide(withIsbn,{...candidate,isbn:['9780306406157']}).match);
  assert.equal(decide(withIsbn,{...candidate,isbn:['9780140328721']}).match,undefined);
  const volume=plan({title:'Example 2.pdf \u00b7 copy 1',isbn:'9780306406157'});
  assert.equal(decide(volume,{title:'Example 3',author_name:['Jane Doe'],isbn:['9780306406157']}).match,undefined);
  assert.equal(local.title,'MYTHS MERMAIDS.pdf \u00b7 versi\u00f3n 1');
});

test('optional copy queries cannot displace a full fourteen-task plan',()=>{
  const source={name:'Surname, CIifford - Saga 2 - Volume.pdf',localDetails:{
    title:'Volume','author(s)':'CIifford Surname',identifiers:['9780306406157','9780140328721']
  }};
  const baseline=r.buildPlan(source,t,c);
  assert.equal(baseline.tasks.length,14);
  const saturated=r.buildPlan(source,{...t,fileCopyTitleVariant:()=> 'A clean title'},c);
  assert.deepEqual(JSON.parse(JSON.stringify(saturated)),JSON.parse(JSON.stringify(baseline)));
});
