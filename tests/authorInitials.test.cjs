const {test} = require('node:test');
const assert = require('node:assert/strict');
const load = require('./loadModule.cjs');
const c = load('helpers/metadataCandidate.ts');
const r = load('helpers/metadataRecovery.ts');
const t = load('helpers/metadataTitle.ts', {'./fileUtils': load('helpers/fileUtils.ts')});
const accepts = (query, result) => !!c.selectMetadataCandidate('Example', query, [{title:'Example', author_name:[result]}]);

test('captured abbreviated authors support the full local name in both directions', () => {
  for (const [full, abbreviated] of [
    ['Alfred A Attanasio', 'A.A. Attanasio'],
    ['Raphael A Lafferty', 'R. A. Lafferty'],
    ['John Ronald Reuel Tolkien', 'J. R. R. Tolkien'],
    ['Attanasio, Alfred A', 'A. A. Attanasio'],
    ['Alfred A Attanasio', 'Attanasio, A. A.'],
    ['Clifford D Simak', 'C. D. Simak']
  ]) {
    assert.ok(accepts(full, abbreviated), full + ' / ' + abbreviated);
    assert.ok(accepts(abbreviated, full), abbreviated + ' / ' + full);
  }
});

test('reverse expansion cannot erase contradictions or invent a shared surname', () => {
  for (const [query, candidate] of [
    ['John Smith', 'James Smith'], ['John Smith', 'J. Jones'],
    ['John Smith', 'John S.'], ['John Smith', 'Smith'],
    ['John Smith', 'J. S.'], ['J. S.', 'John Smith'],
    ['Alfred A Attanasio', 'A. F. Attanasio'],
    ['Alfred A Attanasio', 'A. A. A. Attanasio'],
    ['John Ronald Reuel Tolkien', 'J. R. P. Tolkien'],
    ['John Alan Smith', 'J. Brian Smith'],
    ['John Alan Smith', 'J. Smith'],
    ['John Smith', 'J. Smith Jones'],
    ['Ed McBain', 'Al McBain'], ['Li', 'Lu'],
    ['John Smith', 'John S. Doe']
  ]) assert.equal(accepts(query, candidate), false, query + ' / ' + candidate);
});

test('abbreviations still require a supported individual credit and unambiguous identity', () => {
  const candidate = {title:'Entra en una lata', author_name:['R. A. Lafferty', 'Matilde Horne']};
  assert.ok(c.selectMetadataCandidate(candidate.title, 'Raphael A Lafferty', [candidate]));
  assert.equal(c.selectMetadataCandidate(candidate.title, 'Raphael A Lafferty', [
    {...candidate, author_name:['Raphael Smith', 'A. Lafferty']}
  ]), undefined);
  const plan = r.buildPlan({name:'Example.epub',localDetails:{title:'Example','author(s)':'John Smith'}}, t, c);
  const decision = r.evaluate(plan, [
    {title:'Example',author_name:['J. Smith']},
    {title:'Example',author_name:['John Smith']}
  ], c.selectMetadataCandidate, c.metadataCandidateRejection);
  assert.equal(decision.match, undefined);
  assert.ok(decision.review.some(row => row.reason === 'multiple-compatible-identities'));
});

test('captured candidates recover two supported sources, not the exploratory inverted copy', () => {
  const radix = {title:'Radix',author_name:['A.A. Attanasio'],isbn:['9781473207981']};
  for (const [name, localDetails, candidate, expected] of [
    ['Attanasio, Alfred A - Radix.pdf', {title:'Microsoft Word - Radix.doc','author(s)':'Administrador'}, radix, true],
    ['Lafferty, Raphael A - Entra en una lata.pdf', {title:'ENTRA EN UNA LATA','author(s)':'diaspar'},
      {title:'Entra en una lata',author_name:['R. A. Lafferty','Matilde Horne']}, true],
    ['Nova 27 A.A. Attanasio - Radix.pdf', {title:'Nova 27 A.A. Attanasio','author(s)':'Radix'}, radix, false]
  ]) {
    const plan = r.buildPlan({name,localDetails}, t, c);
    assert.equal(!!r.evaluate(plan, [candidate], c.selectMetadataCandidate, c.metadataCandidateRejection).match, expected, name);
  }
});

test('the actual Spanish Radix ISBN permits only work information from the English edition', () => {
  const source = {name:'Attanasio, Alfred A - Radix.pdf',localDetails:{
    title:'Microsoft Word - Radix.doc','author(s)':'Administrador',isbn:'84-406-1346-6'
  }};
  const plan = r.buildPlan(source, t, c);
  assert.equal(plan.isbns.length, 1);
  const decision = r.evaluate(plan, [{title:'Radix',author_name:['A.A. Attanasio'],
    isbn:['9781473207981','1473207983']}], c.selectMetadataCandidate, c.metadataCandidateRejection);
  assert.ok(decision.match);
  assert.equal(decision.evidence, 'different-edition-work-identity');
  const stored = r.metadataForStorage(plan, decision.match, 'google', source.localDetails);
  assert.equal(stored._metadataScope, 'work');
  assert.equal(stored.isbn, undefined);
});
