const {test} = require('node:test');
const assert = require('node:assert/strict');
const load = require('./loadModule.cjs');
const recovery = load('helpers/metadataRecovery.ts');
const candidates = load('helpers/metadataCandidate.ts');
const titles = load('helpers/metadataTitle.ts', {'./fileUtils':load('helpers/fileUtils.ts')});
const plan = details => recovery.buildPlan({name:'Example.pdf',localDetails:{title:'Example','author(s)':'John Smith',...details}},titles,candidates);
const decide = (p, books) => recovery.evaluate(p, books, candidates.selectMetadataCandidate, candidates.metadataCandidateRejection);
const book = {title:'Example',author_name:['John Smith'],description:'A description of the work.',subject:['Fiction'],
  first_sentence:['Opening sentence.'],isbn:['9780306406157'],language:['en'],publisher:['Example Publisher'],
  first_publish_year:2001,key:'/works/OL1W',cover_i:123,cover_edition_key:'OL2M',edition_count:4,
  has_fulltext:true,public_scan_b:true,ebook_access:'borrowable',untrusted_future_field:'do not propagate'};
const json = value => JSON.parse(JSON.stringify(value));

test('unknown or different edition keeps useful work fields without leaking edition attributes', () => {
  for (const details of [{},{isbn:'9780140328721'},{isbn:'invalid'}]) {
    const p = plan(details), original = JSON.stringify(book), decision = decide(p,[book]);
    assert.ok(decision.match);
    for (const provider of ['google','ol']) {
      const stored = json(recovery.metadataForStorage(p,decision.match,provider,details));
      assert.deepEqual(stored,{title:'Example',key:'/works/OL1W',author_name:['John Smith'],subject:['Fiction'],
        description:'A description of the work.',first_sentence:['Opening sentence.'],cover_i:123,
        _source:provider==='google'?'google-books':'openlibrary',_metadataScope:'work'});
    }
    assert.equal(JSON.stringify(book), original);
  }
});

test('individual Google ISBN match keeps only matching ISBNs and edition fields', () => {
  const p = plan({isbn:'0-306-40615-2'});
  const candidate = {...book,isbn:['9780306406157','0306406152','9780140328721']};
  assert.equal(decide(p,[candidate]).evidence,'isbn-and-identity');
  const stored = json(recovery.metadataForStorage(p,candidate,'google',{isbn:'0-306-40615-2'}));
  assert.equal(stored._metadataScope,'edition');
  assert.deepEqual(stored.isbn,['9780306406157','0306406152']);
  assert.deepEqual(stored.publisher,book.publisher);
  assert.deepEqual(stored.language,book.language);
  assert.equal(stored.first_publish_year,2001);
  assert.equal(stored.untrusted_future_field,undefined);
  assert.equal(stored.cover_edition_key,undefined);
});

test('OpenLibrary aggregate remains a work even with a source ISBN in its edition list', () => {
  const p = plan({isbn:'9780306406157'});
  const stored = json(recovery.metadataForStorage(p,{...book,language:['en','fr','es']},'ol',{isbn:'9780306406157'}));
  assert.equal(stored._metadataScope,'work');
  for (const field of ['isbn','language','publisher','first_publish_year','edition_count','ebook_access'])
    assert.equal(Object.hasOwn(stored,field),false,field);
});

test('work enrichment never relaxes author, title, volume, missing evidence or ambiguity gates', () => {
  const p = plan({isbn:'9780140328721'});
  for (const candidate of [
    {...book,title:'Unrelated'}, {...book,title:'Example 2'},
    {...book,author_name:['James Smith']}, {...book,author_name:[]}
  ]) assert.equal(decide(p,[candidate]).match,undefined);
  const noAuthor = recovery.buildPlan({name:'Example.pdf',localDetails:{title:'Example'}},titles,candidates);
  assert.equal(decide(noAuthor,[book]).match,undefined);
  assert.equal(decide(p,[book,{...book,author_name:['John Andrew Smith']}]).match,undefined);
  const exploratory = recovery.buildPlan({name:'Nova 27 A.A. Attanasio - Radix.pdf',
    localDetails:{title:'Nova 27 A.A. Attanasio','author(s)':'Radix',isbn:'9780140328721'}},titles,candidates);
  const rejected = decide(exploratory,[{...book,title:'Radix',author_name:['A.A. Attanasio']}]);
  assert.equal(rejected.match,undefined);
  assert.ok(rejected.review.some(row=>row.reason==='exploratory-hypothesis-needs-evidence'));
});

test('projection copies arrays and cannot modify the provider response or original metadata', () => {
  const details = {isbn:'9780306406157'};
  const sourceBefore = JSON.stringify(details), responseBefore = JSON.stringify(book);
  const stored = recovery.metadataForStorage(plan(details),book,'google',details);
  stored.author_name.push('Another');stored.subject.push('Other');stored.publisher.push('Other');
  stored.language.push('Other');stored.isbn.push('Other');stored.first_sentence.push('Other');
  assert.equal(JSON.stringify(book),responseBefore);
  assert.equal(JSON.stringify(details),sourceBefore);
});
