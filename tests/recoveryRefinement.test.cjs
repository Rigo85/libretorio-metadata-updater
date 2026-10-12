const {test}=require('node:test');
const assert=require('node:assert/strict');
const load=require('./loadModule.cjs');
const c=load('helpers/metadataCandidate.ts');
const t=load('helpers/metadataTitle.ts',{'./fileUtils':load('helpers/fileUtils.ts')});
const r=load('helpers/metadataRecovery.ts');
const plan=(name,localDetails)=>r.buildPlan({name,localDetails},t,c);
const decide=(p,rows)=>r.evaluate(p,rows,c.selectMetadataCandidate,c.metadataCandidateRejection);
const select=(author,authors)=>c.selectMetadataCandidate('Example',author,[{title:'Example',author_name:authors}]);

test('previously reviewed real matches survive author hardening and query changes',()=>{
  const sources=require('./fixtures/recovery-plans.json');
  for(const [id,title,authors] of [
    [93846,'El Palacio de la eternidad',['Bob Shaw','Francisco Cazorla Olmo']],
    [99580,'Heliconia Invierno',['Brian W. Aldiss']],
    [72368,'La Barrera santaroga',['Frank Herbert']],
    [79353,'El verano del pequeño San John',['John Crowley']]
  ]){
    const source=sources.find(row=>row.id===id);
    assert.ok(source);
    assert.ok(decide(plan(source.name,source.localDetails),[{title,author_name:authors}]).match,String(id));
  }
  for(const [title,author,candidateTitle,candidateAuthor] of [
    ['Estacion de tránsito','Clifford D. Simak [Simak, Clifford D.]','Estación de tránsito','Clifford D. Simak'],
    ['Tierra Dos','Jaime Ministral [Jaime Ministral]','Tierra-dos','Jaime Ministral Masia']
  ])assert.ok(decide(plan(title+'.epub',{title,'author(s)':author}),[{title:candidateTitle,author_name:[candidateAuthor]}]).match);
});

test('short real names are evidence, not discarded tokens',()=>{
  for(const author of ['Li','Yu','Ed','Lu Xun','Mo Yan']){
    assert.ok(select(author,[author]),author);
    assert.equal(select(author,['Otra Persona']),undefined,author);
    assert.equal(select(author,[]),undefined,author);
  }
  assert.equal(select('A.',['Otra Persona']),undefined);
  assert.equal(select('A. B.',['A. B.']),undefined);
});

test('initials may be omitted or expanded but supplied contradictions never disappear',()=>{
  for(const [query,result] of [
    ['A. A. Attanasio','Alfred Angelo Attanasio'],['A. A. Attanasio','Attanasio'],
    ['Clifford D. Simak','Clifford Simak'],['J. R. R. Tolkien','John Ronald Reuel Tolkien'],
    ['L. Sprague de Camp','Sprague de Camp'],['Ed McBain','Ed McBain']
  ])assert.ok(select(query,[result]),query+' / '+result);
  for(const [query,result] of [
    ['A. A. Attanasio','F. Attanasio'],['A. A. Attanasio','A. F. Attanasio'],
    ['Clifford D. Simak','Clifford F. Simak'],['J. R. R. Tolkien','John Robert Patrick Tolkien'],
    ['Ed McBain','Al McBain'],['Juan Perez','Juan Garcia']
  ])assert.equal(select(query,[result]),undefined,query+' / '+result);
});

test('coauthors must remain supported by individual credits',()=>{
  assert.ok(select('L. Sprague de Camp y Fletcher Pratt',['Sprague de Camp','Fletcher Pratt']));
  assert.equal(select('John Smith',['John Doe','Jane Smith']),undefined);
  assert.equal(select('Li & Yu',['Li']),undefined);
  assert.ok(select('Jose Ortega y Gasset',['Jose Ortega y Gasset']));
});

test('system authors and trailing technical/source markers are cleaned contextually',()=>{
  for(const author of ['Usuario de Windows','Windows User','Usuario de Windows 10'])
    assert.equal(c.resolveMetadataAuthor({'author(s)':author}),undefined);
  assert.equal(c.resolveMetadataAuthor({'author(s)':'John Windows'}),'John Windows');
  assert.equal(t.resolveMetadataTitle('file.pdf',{title:'Examen 2014-II.indd'}).title,'Examen 2014 II');
  assert.equal(t.resolveMetadataTitle('file.pdf',{title:'InDesign para usuarios de Windows'}).title,'InDesign para usuarios de Windows');
  assert.equal(t.resolveMetadataTitle('file.pdf',{title:'日本語 by toshi (z-lib.org)'}).title,'日本語 by toshi');
  assert.equal(t.resolveFilenameSearch('Book 2 (z-lib.org).pdf').title,'Book 2');
  assert.equal(t.resolveMetadataTitle('file.pdf',{title:'Book (second edition)'}).title,'Book second edition');
  assert.equal(t.resolveMetadataTitle('file.pdf',{title:'1984'}).title,'1984');
});

test('removing a generic author alone does not authorize a title-only match',()=>{
  const p=plan('Bonsai.pdf',{title:'Bonsai','author(s)':'Usuario de Windows'});
  assert.equal(p.hypotheses[0].author,undefined);
  const result=decide(p,[{title:'Bonsai',author_name:['Test Writer']}]);
  assert.equal(result.match,undefined);
  assert.ok(result.review.some(row=>row.reason==='title-only-no-author-evidence'));
});

test('Radix alternate is exploratory and cannot authorize its own identity',()=>{
  const source={title:'Nova 27 A.A. Attanasio','author(s)':'Radix'};
  const original=JSON.stringify(source);
  const p=plan('Nova 27 A.A. Attanasio - Radix.pdf',source);
  const h=p.hypotheses.find(h=>h.title==='Radix');
  assert.equal(h.author,'A.A. Attanasio');assert.equal(h.queryOnly,true);
  const result=decide(p,[{title:'Radix',author_name:['Alfred Angelo Attanasio']}]);
  assert.equal(result.match,undefined);
  assert.ok(result.review.some(row=>row.reason==='exploratory-hypothesis-needs-evidence'));
  assert.equal(JSON.stringify(source),original);
});

test('filename guesses cannot demote valid local metadata or swap numbered publication/date',()=>{
  const p=plan('Dune Messiah - Frank Herbert.epub',{title:'Dune Messiah','author(s)':'Frank Herbert'});
  assert.ok(decide(p,[{title:'Dune Messiah',author_name:['Frank Herbert']}]).match);
  const journal=plan('Clio 170 - Diciembre 2015.pdf',{title:'Clio 170','author(s)':'Diciembre 2015'});
  assert.equal(journal.hypotheses.length,1);
  assert.equal(journal.hypotheses[0].title,'Clio 170');
});

test('specific I/l confusion is query-only, not a global fuzzy acceptance rule',()=>{
  const p=plan('Book.epub',{title:'Buenas Noches Señor James','author(s)':'CIifford D. Simak'});
  assert.ok(p.hypotheses.some(h=>h.author==='Clifford D. Simak'&&h.queryOnly));
  assert.equal(decide(p,[{title:'Buenas Noches Señor James',author_name:['Clifford D. Simak']}]).match,undefined);
  assert.ok(decide(p,[{title:'Buenas Noches Señor James',author_name:['CIifford D. Simak']}]).match);
  assert.equal(plan('Book.epub',{title:'Book','author(s)':'Ilan Smith'}).hypotheses.length,1);
  assert.equal(plan('Book.epub',{title:'Book','author(s)':'PIkasle-ren Kolaboratzaileak'}).hypotheses.length,1);
});

test('valid exact source ISBN can corroborate an exploratory identity; other editions cannot',()=>{
  const p=plan('Book.epub',{title:'Buenas Noches Señor James','author(s)':'CIifford D. Simak',isbn:'9780306406157'});
  const candidate={title:'Buenas Noches Señor James',author_name:['Clifford D. Simak'],isbn:['9780306406157']};
  assert.ok(decide(p,[candidate]).match);
  assert.equal(decide(p,[{...candidate,isbn:['9780140328721']}]).match,undefined);
  assert.equal(decide(p,[{...candidate,title:'Another Book'}]).match,undefined);
});

test('volume, author, edition and ambiguity reasons remain distinguishable',()=>{
  const p=plan('Book.pdf',{title:'Example 2','author(s)':'John Smith'});
  for(const [candidate,reason] of [
    [{title:'Example 3',author_name:['John Smith']},'volume-mismatch'],
    [{title:'Different 2',author_name:['John Smith']},'title-mismatch'],
    [{title:'Example 2',author_name:['John Doe']},'author-mismatch'],
    [{title:'Example 2'},'missing-author']
  ]){const d=decide(p,[candidate]);assert.equal(d.match,undefined);assert.ok(d.review.some(row=>row.reason===reason));}
  const d=decide(p,[{title:'Example 2',author_name:['John Smith']},{title:'Example 2',author_name:['John Andrew Smith']}]);
  assert.equal(d.match,undefined);assert.ok(d.review.some(row=>row.reason==='multiple-compatible-identities'));
});

test('larger plans preserve both providers and ISBN queries inside the existing cap',()=>{
  const p=plan('Surname, CIifford - Saga 2 - Volume.pdf',{
    title:'Volume','author(s)':'CIifford Surname',identifiers:['9780306406157','9780140328721']
  });
  assert.ok(p.hypotheses.length>=4);assert.equal(p.tasks.length,14);
  assert.equal(p.tasks.filter(task=>task.strategy==='isbn').length,2);
  for(const h of p.hypotheses)for(const provider of ['google','openlibrary'])
    assert.ok(p.tasks.some(task=>task.provider===provider&&!task.general&&task.text===h.title&&task.author===h.author));
  const keys=p.tasks.map(task=>JSON.stringify([task.provider,task.query,task.author,task.provider==='openlibrary'?task.general:null]));
  assert.equal(new Set(keys).size,keys.length);
});
