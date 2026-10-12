const {test} = require('node:test');
const assert = require('node:assert/strict');
const load = require('./loadModule.cjs');
const c = load('helpers/metadataCandidate.ts');
const r = load('helpers/metadataRecovery.ts');
const t = load('helpers/metadataTitle.ts', {'./fileUtils':load('helpers/fileUtils.ts')});
const plan = details => r.buildPlan({name:'Example.pdf',localDetails:{title:'Example','author(s)':'John Smith',...details}},t,c);
const decide = (p, books) => r.evaluate(p,books,c.selectMetadataCandidate,c.metadataCandidateRejection);

test('ISBN must be a complete identifier, never a valid substring of a longer number', () => {
  for (const value of ['97803064061570','19780306406157','03064061520','00306406152'])
    assert.equal(r.identifiers({isbn:value}).length,0,value);
  assert.deepEqual([...r.identifiers({isbn:'978-0-306-40615-7'})],['9780306406157']);
  assert.deepEqual([...r.identifiers({identifiers:'isbn:9780306406157, isbn:9780140328721'})],['9780306406157','9780140328721']);
});

test('structured identifier namespaces cannot turn an ASIN or internal code into ISBN evidence', () => {
  assert.equal(r.identifiers({identifiers:{asin:'9780306406157',internal:'9780140328721'}}).length,0);
  assert.deepEqual([...r.identifiers({identifiers:{isbn:'9780306406157'}})],['9780306406157']);
  assert.deepEqual([...r.identifiers({identifiers:[{type:'ISBN_13',identifier:'9780306406157'}]})],['9780306406157']);
  assert.deepEqual([...r.identifiers({isbn:9780306406157})],['9780306406157']);
});

test('prefer exact source ISBN among the same identity regardless of provider ordering', () => {
  const p=plan({isbn:'9780306406157'});
  const work={title:'Example',author_name:['John Smith'],isbn:['9780140328721']};
  const edition={...work,isbn:['0306406152']};
  for(const rows of [[work,edition],[edition,work]])assert.equal(decide(p,rows).match,edition);
  assert.equal(decide(p,[work]).match,work);
  assert.equal(decide(p,[edition,{...edition,author_name:['James Smith']}]).match,edition);
});

test('numbered volumes written as Roman numerals cannot disappear in title similarity', () => {
  for(const [left,right] of [
    ['La historia de los pueblos II','La historia de los pueblos III'],
    ['Las cronicas del mundo tomo II','Las cronicas del mundo tomo III'],
    ['La historia de los pueblos II','La historia de los pueblos'],
    ['La historia de los pueblos 2','La historia de los pueblos 3']
  ])assert.equal(c.selectMetadataCandidate(left,'John Smith',[{title:right,author_name:['John Smith']}]),undefined,left);
  assert.ok(c.selectMetadataCandidate('Yo robot','Isaac Asimov',[{title:'Yo robot',author_name:['Isaac Asimov']}]));
  assert.ok(c.selectMetadataCandidate('I Robot','Isaac Asimov',[{title:'I Robot',author_name:['Isaac Asimov']}]));
  assert.ok(c.selectMetadataCandidate('La historia II','John Smith',[{title:'la historia ii',author_name:['John Smith']}]));
  assert.ok(c.selectMetadataCandidate('Historia tomo II','John Smith',[{title:'Historia tomo 2',author_name:['John Smith']}]));
  assert.equal(c.selectMetadataCandidate('Malcolm X','John Smith',[{title:'Malcolm 10',author_name:['John Smith']}]),undefined);
});

test('generated volume pairs reject cross-volume matches and keep case variants', () => {
  const romans=['I','II','III','IV','V','VI','VII','VIII','IX','X','XI','XII'];
  for(const left of romans)for(const right of romans){
    const title='Las extensas cronicas de los pueblos '+left;
    const result={title:('Las extensas cronicas de los pueblos '+right).toLowerCase(),author_name:['John Smith']};
    assert.equal(!!c.selectMetadataCandidate(title,'John Smith',[result]),left===right,`${left}/${right}`);
  }
});

test('long or deeply nested identifiers stay bounded and never recurse indefinitely', () => {
  const cyclic={};cyclic.isbn=cyclic;
  for(const identifiers of [cyclic,Array(10000).fill({asin:'9780306406157'}),'1'.repeat(100000)])
    assert.equal(r.identifiers({identifiers}).length,0);
  assert.equal(r.identifiers({identifiers:Array(10000).fill('9780306406157')}).length,1);
});
