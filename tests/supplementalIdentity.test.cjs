const {test}=require('node:test'),assert=require('node:assert/strict');
const load=require('./loadModule.cjs');
const authors=load('helpers/metadataCandidate.ts'),recovery=load('helpers/metadataRecovery.ts');
const titles=load('helpers/metadataTitle.ts',{'./fileUtils':load('helpers/fileUtils.ts')});
const source={name:'Mark Clifton y Frank Riley La maquina de la eternidad Premio Hugo 1955.epub',
  localDetails:{title:'M. Clifton y F. Riley','author(s)':'La m\u00e1quina de la eternidad [La m\u00e1quina de la eternidad]',identifiers:'isbn:84-666-0864-8'}};
const award={name:'Hiroshi Sakurazaka Al filo del manana nominada al premio Seioun.epub',
  localDetails:{title:'Al filo del manana nominada al premio Seioun','author(s)':'Hiroshi Sakurazaka',identifiers:'isbn:9781421542447'}};
const build=row=>recovery.buildPlan(row,titles,authors);
const decide=(plan,candidates)=>recovery.evaluate(plan,candidates,authors.selectMetadataCandidate,authors.metadataCandidateRejection);
const extra=plan=>plan.hypotheses.filter(h=>['award-suffix-isbn-only','coauthor-swap-isbn-only'].includes(h.evidence));

test('coauthor inversion is corroborated by both filename credits, preserves source and adds only two last queries',()=>{
  const before=JSON.stringify(source),plan=build(source),h=extra(plan)[0];
  assert.equal(h.title,'La m\u00e1quina de la eternidad');assert.equal(h.author,'mark clifton & frank riley');
  assert.equal(h.queryOnly,true);assert.equal(h.validationOnly,true);
  assert.equal(plan.hypotheses[0].title,'M Clifton y F Riley');
  assert.equal(JSON.stringify(source),before);assert.ok(plan.tasks.length<=14);
  assert.deepEqual(Array.from(plan.tasks.slice(-2),t=>[t.provider,t.strategy]),
    [['google','coauthor-swap-isbn-only'],['openlibrary','coauthor-swap-isbn-only']]);
  const book={title:h.title,author_name:['Mark Clifton','Frank Riley'],isbn:['9788466608640']};
  assert.equal(decide(plan,[book]).match,book);
  for(const change of [{isbn:[]},{isbn:['9780306406157']},{author_name:['Mark Clifton']},
    {author_name:['Mark Clifton','Fred Riley']},{title:h.title+' 2'},{title:'Otra novela'}])
    assert.equal(decide(plan,[{...book,...change}]).match,undefined);
});

test('ambiguous or contradictory filename layouts never generate a coauthor swap',()=>{
  for(const name of [source.name.replace('Frank Riley','William Riley'),source.name.replace('Mark Clifton y ',''),
    source.name.replace('Premio Hugo 1955','Capitulo 2'),source.name.replace('Mark Clifton','Otro Mark Clifton'),
    'Mark Clifton y Frank Riley La maquina de la eternidad La maquina de la eternidad.epub'])
    assert.equal(extra(build({...source,name})).length,0,name);
  for(const identifiers of ['', 'isbn:1234567890'])assert.equal(extra(build({...source,localDetails:{...source.localDetails,identifiers}})).length,0);
  assert.equal(extra(build({name:'John y Jane Premio Hugo.epub',localDetails:{title:'John y Jane','author(s)':'Premio Hugo',isbn:'9780306406157'}})).length,0);
});

test('award suffix is a narrow optional hypothesis, not global title cleanup',()=>{
  for(const suffix of ['nominada al premio Seioun','nominado al premio Hugo 1955','ganadora del premio Nebula'])
    assert.equal(titles.awardTitleVariant('Un titulo '+suffix),'Un titulo');
  for(const value of ['La nominada al premio Nobel','Premio Hugo 1955','El premio Nobel','El premio al asesino',
    'Un titulo nominada al premio Hugo y otros cuentos 2','Un titulo nominada al premio Hugo: otro subtitulo',
    'A'.repeat(501)+' nominada al premio Hugo'])assert.equal(titles.awardTitleVariant(value),undefined,value);
  const before=JSON.stringify(award),plan=build(award),h=extra(plan)[0];
  assert.equal(h.title,'Al filo del manana');assert.equal(h.queryOnly,true);
  assert.equal(plan.hypotheses[0].title,award.localDetails.title);assert.equal(JSON.stringify(award),before);
  assert.deepEqual(Array.from(plan.tasks.slice(-2),t=>t.provider),['google','openlibrary']);
  assert.ok(plan.tasks.length<=14);
});

test('short title cannot erase ISBN, author, volume or negation constraints',()=>{
  const plan=build(award),book={title:'Al filo del manana',author_name:['Hiroshi Sakurazaka'],isbn:['9781421542447']};
  assert.equal(decide(plan,[book]).match,book);
  for(const change of [{isbn:[]},{isbn:['9780306406157']},{author_name:['Otro Autor']},
    {title:'Al filo del manana 2'},{title:'All You Need Is Kill'}])assert.equal(decide(plan,[{...book,...change}]).match,undefined);
  const negative=build({...award,localDetails:{...award.localDetails,title:'No hay salida 2 nominada al premio Hugo'}});
  for(const title of ['Hay salida 2','No hay salida 3','No hay salida'])
    assert.equal(decide(negative,[{...book,title}]).match,undefined);
  assert.equal(extra(build({...award,localDetails:{...award.localDetails,identifiers:''}})).length,0);
  assert.equal(extra(build({...award,localDetails:{...award.localDetails,'author(s)':'Unknown'}})).length,0);
});

test('existing task order is unchanged and exploratory variants cannot expand the plan budget',()=>{
  const oldTitles={...titles,awardTitleVariant:()=>undefined};
  for(const row of [source,award]){
    const oldAuthors={...authors,metadataCandidateRejection:()=> 'disabled-probe'};
    const previous=recovery.buildPlan(row,oldTitles,oldAuthors),plan=build(row);
    assert.equal(JSON.stringify(plan.tasks.slice(0,previous.tasks.length)),JSON.stringify(previous.tasks));
    assert.ok(plan.tasks.length<=14);
    assert.ok(plan.hypotheses.length<=6);
  }
});
