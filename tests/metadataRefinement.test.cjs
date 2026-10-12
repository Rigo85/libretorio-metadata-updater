const {test}=require('node:test');
const assert=require('node:assert/strict');
require('ts-node').register({transpileOnly:true});
const {resolveMetadataAuthor,selectMetadataCandidate:select}=require('../src/helpers/metadataCandidate.ts');
const {resolveFilenameSearch,resolveMetadataTitle}=require('../src/helpers/metadataTitle.ts');
const {lookupWithFallback}=require('../src/helpers/metadataLookup.ts');

test('generic OS/admin/collective author variants do not constrain searches',()=>{
  for(const author of ['Windows XP','Windows 10','Administrador','Varios autores','Varios Autores [Autores, Varios]','AA.VV.']) {
    assert.equal(resolveMetadataAuthor({'author(s)':author}),undefined,author);
  }
});
test('only duplicated bracket author is removed; additional credited text is not discarded',()=>{
  assert.equal(resolveMetadataAuthor({'author(s)':'Daniel Beltran Sanchez [Daniel Beltran Sanchez]'}),'Daniel Beltran Sanchez');
  assert.equal(resolveMetadataAuthor({'author(s)':'Juan Perez [editor]'}),'Juan Perez [editor]');
});
test('coauthors may be credited separately; every named person remains required',()=>{
  const author='L. Sprague de Camp y Fletcher Pratt';
  const good={title:'Elephas frumenti',author_name:['L. Sprague de Camp','Fletcher Pratt']};
  assert.equal(select(good.title,author,[good]),good);
  assert.equal(select(good.title,author,[{...good,author_name:['L. Sprague de Camp']}]),undefined);
  assert.equal(select('Example','John Smith',[{title:'Example',author_name:['John Doe','Jane Smith']}]),undefined);
  const compound={title:'Example',author_name:['Jose Ortega y Gasset']};
  assert.equal(select('Example','Jose Ortega y Gasset',[compound]),compound);
});
test('explicit surname-name filename convention is parsed without guessing arbitrary names',()=>{
  assert.deepEqual(resolveFilenameSearch('Baxter, Stephen - El abismo del espaciotiempo.doc'),{title:'El abismo del espaciotiempo',author:'Stephen Baxter'});
  assert.deepEqual(resolveFilenameSearch('Dune - 02.epub'),{title:'Dune 02'});
  assert.equal(resolveFilenameSearch('Reynolds, Alastair - [ER4] - El Desfiladero.PDF').title,'ER4 El Desfiladero');
  assert.deepEqual(resolveFilenameSearch('Doe, John - First - Second.pdf'),{title:'First Second',author:'John Doe'});
});
test('technical title falls back; filenames embedded in local title lose only known extension',()=>{
  assert.equal(resolveMetadataTitle('capitulo07.pdf',{title:'Microsoft Word - capitulo07.doc'}).reason,'technical-title');
  assert.equal(resolveMetadataTitle('elibertades2010.pdf',{title:'© Lorenzo Cotino y otros'}).source,'filename');
  assert.equal(resolveMetadataTitle('Geom.pdf',{title:'geomrecreat07.doc'}).title,'geomrecreat07');
  assert.equal(resolveMetadataTitle('1984.pdf',{title:'1984'}).title,'1984');
  for(const title of ['Microsoft Word 2016 paso a paso','Copyright and the Public Domain']) {
    assert.equal(resolveMetadataTitle('manual.pdf',{title}).source,'localDetails');
  }
  assert.equal(resolveMetadataTitle('manual.pdf',{title:'Copyright 2010 Editorial'}).reason,'technical-title');
});
test('secondary query is bounded and only after complete primary without match',async()=>{
  for(const first of ['error','limited',{webDetails:{title:'OK'}}]) {
    let calls=0;
    assert.equal(await lookupWithFallback('primary','fallback',async()=>{calls++;return first;}),first);
    assert.equal(calls,1);
  }
  const calls=[];
  assert.equal(await lookupWithFallback('primary','fallback',async(title,general)=>{calls.push([title,general]);return undefined;}),undefined);
  assert.deepEqual(calls,[['primary',false],['fallback',true]]);
});
test('secondary errors and rejection are not reported as empty successful search',async()=>{
  let calls=0;
  assert.equal(await lookupWithFallback('a','b',async()=>++calls===1?undefined:'error'),'error');
  calls=0;
  assert.equal(await lookupWithFallback('a','b',async()=>++calls===1?'rejected':undefined),'rejected');
});
