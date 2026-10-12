const {test} = require('node:test');
const assert = require('node:assert/strict');
require('ts-node').register({transpileOnly: true});
const {resolveMetadataTitle,resolveMetadataSearch} = require('../src/helpers/metadataTitle.ts');
const {resolveMetadataAuthor,selectMetadataCandidate} = require('../src/helpers/metadataCandidate.ts');

const name = 'Legendarium 02 Los hijos de hurin - J. R. R. Tolkien.epub';
const title = 'Los hijos de H\u00farin';
const fallback = 'Legendarium 02 Los hijos de hurin J R R Tolkien';

test('JSONB object and historical JSON string resolve to the same local title', () => {
  const details = Object.freeze({title, 'author(s)': 'J. R. R. Tolkien'});
  for (const value of [details, JSON.stringify(details)]) {
    assert.deepEqual(resolveMetadataTitle(name, value), {title, source: 'localDetails', reason: 'local-title'});
  }
  assert.equal(details.title, title);
  assert.equal(details['author(s)'], 'J. R. R. Tolkien');
});

const cases = [
  [null, 'missing-details'], [undefined, 'missing-details'],
  ['', 'invalid-json'], ['broken-json', 'invalid-json'],
  ['null', 'not-object'], ['[]', 'not-object'], ['42', 'not-object'],
  [[], 'not-object'], [false, 'not-object'], [1, 'not-object'],
  [{}, 'missing-title'], [{title: null}, 'missing-title'],
  [{title: 42}, 'invalid-title'], [{title: {}}, 'invalid-title'],
  [{title: ['A book']}, 'invalid-title'], [{title: false}, 'invalid-title'],
  [{title: ''}, 'empty-title'], [{title: ' \n\t '}, 'empty-title'],
  [{title: '---'}, 'empty-cleaned-title']
];
for (const [value, reason] of cases) {
  test(`explicit filename fallback: ${JSON.stringify(value)} (${reason})`, () => {
    assert.deepEqual(resolveMetadataTitle(name, value), {title: fallback, source: 'filename', reason});
  });
}

test('does not add bibliographic heuristics or strip significant numbers', () => {
  assert.equal(resolveMetadataTitle('1984.epub', {title: '1984'}).title, '1984');
  assert.equal(resolveMetadataTitle(name, {title: 'Kane, Silver'}).title, 'Kane Silver');
});

test('suspected swapped fields do not replace the primary local pair before provider verification', () => {
  const details=Object.freeze({title:'Shaw, Bob','author(s)':'El palacio de la eternidad'});
  for(const input of [details,JSON.stringify(details)]){
    const query=resolveMetadataSearch('Shaw, Bob - El palacio de la eternidad.pdf',input,resolveMetadataAuthor(input));
    assert.deepEqual(query,{title:{title:'Shaw Bob',source:'localDetails',reason:'local-title'},
      author:'El palacio de la eternidad',fallbackTitle:'Shaw Bob'});
    assert.equal(selectMetadataCandidate(query.title.title,query.author,[{title:query.title.title,author_name:['Unrelated Author']}]),undefined);
  }
  assert.equal(details.title,'Shaw, Bob');assert.equal(details['author(s)'],'El palacio de la eternidad');
});

test('one conflicting field, a valid local pair or a different volume never triggers a swap', () => {
  for(const details of [
    {title:'Shaw, Bob','author(s)':'Someone Else'},
    {title:'El palacio de la eternidad','author(s)':'Bob Shaw'},
    {title:'Shaw, Bob','author(s)':'El palacio de la eternidad 2'}
  ]){
    const query=resolveMetadataSearch('Shaw, Bob - El palacio de la eternidad.pdf',details,resolveMetadataAuthor(details));
    assert.equal(query.title.source,'localDetails');assert.equal(query.author,details['author(s)']);
  }
});

test('comma titles stay primary regardless of capitalization or apparent personal-name shape',()=>{
  for(const title of ['El gran libro de los ba\u00f1os, riegos y despojos','El Gran Libro, Del Mundo',
    'Un titulo, con varias frases','Orgullo, Prejuicio']){
    const details={title,'author(s)':'Luisa de la Cruz Zambrana'};
    const query=resolveMetadataSearch(title+' - '+details['author(s)']+'.pdf',details,details['author(s)']);
    assert.equal(query.title.reason,'local-title');assert.equal(query.title.title,resolveMetadataTitle('',details).title);
    assert.equal(query.author,details['author(s)']);assert.equal(query.fallbackTitle,query.title.title);
  }
});
