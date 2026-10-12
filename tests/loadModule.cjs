const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

module.exports = function loadModule(file, mocks = {}, globals = {}) {
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true}
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, {exports, AbortSignal, setTimeout: callback => callback(), require: id => {
    if (!Object.hasOwn(mocks, id)) throw Error(`Unmocked dependency: ${id}`);
    return mocks[id];
  }, ...globals});
  return exports;
};
