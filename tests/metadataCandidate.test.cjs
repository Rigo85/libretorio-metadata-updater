const {test} = require('node:test');
const assert = require('node:assert/strict');
require('ts-node').register({transpileOnly: true});
const {resolveMetadataAuthor, selectMetadataCandidate: select} = require('../src/helpers/metadataCandidate.ts');
const {cleanFilename, cleanTitle} = require('../src/helpers/fileUtils.ts');

test('cleaning keeps Unicode and does not truncate dotted names without a known extension', () => {
  assert.equal(cleanFilename('J. R. R. Tolkien'), 'J R R Tolkien');
  assert.equal(cleanTitle('Müller: 日本語'), 'Müller 日本語');
  assert.equal(cleanFilename('1984.epub'), '1984');
});
test('author accepts object and JSON; ignores generic exporter names', () => {
  assert.equal(resolveMetadataAuthor({'author(s)': 'J. R. R. Tolkien'}), 'J. R. R. Tolkien');
  assert.equal(resolveMetadataAuthor('{"author(s)":"Sheri S. Tepper"}'), 'Sheri S. Tepper');
  for (const author of ['unknown', 'Windows User', 'BOOKSMEDICOS.ORG', 'https://test.org']) {
    assert.equal(resolveMetadataAuthor({'author(s)': author}), undefined);
  }
});
test('selects compatible candidate instead of blindly choosing the first', () => {
  const good = {title: 'La sombra del gigante', author_name: ['Orson Scott Card']};
  assert.equal(select(good.title, 'Orson Scott Card', [{title: 'La sombra de Ender', author_name: ['Carlos Montes']}, good]), good);
});
test('rejects different volume, unrelated title, conflicting author and ambiguous homonyms', () => {
  assert.equal(select('Boris Dekker 4', undefined, [{title: 'Boris Dekker 2'}]), undefined);
  assert.equal(select('El estudio adecuado', 'Isaac Asimov', [{title: 'Informe de langostas'}]), undefined);
  assert.equal(select('El jardinero', 'Sheri S. Tepper', [{title: 'El jardinero', author_name: ['Rabindranath Tagore']}]), undefined);
  assert.equal(select('El jardinero', undefined, [{title: 'El jardinero', author_name: ['Sheri S. Tepper']}, {title: 'El jardinero', author_name: ['Rabindranath Tagore']}]), undefined);
});
test('does not claim a translated title is equivalent merely because the author matches', () => {
  assert.equal(select('Dragones inteligentes', 'Alan Dean Foster', [{title: 'Smart Dragons', author_name: ['Alan Dean Foster']}]), undefined);
});
test('a common first name cannot override contradictory remaining author names', () => {
  assert.equal(select('El jardinero', 'Juan Perez', [{title:'El jardinero', author_name:['Juan Garcia']}]),undefined);
});
