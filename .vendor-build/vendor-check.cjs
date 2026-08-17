const assert = require('node:assert/strict');
const m = require('../vendor/mathjax.cjs');
const expectedDefault = [
  'base','action','ams','amscd','bbox','boldsymbol','braket','bussproofs','cancel','cases',
  'centernot','color','colortbl','empheq','enclose','extpfeil','gensymb','mathtools','mhchem',
  'newcommand','upgreek','unicode','verb','tagformat','textcomp','textmacros',
];
assert.deepEqual(m.DEFAULT_TEX_PACKAGES, expectedDefault);
assert.deepEqual(m.OPTIONAL_TEX_PACKAGES, ['physics', 'colorv2', 'setoptions']);

function convert(packages, latex) {
  const adaptor = m.liteAdaptor({ cjkCharWidth: 1, unknownCharWidth: .6, unknownCharHeight: .8 });
  m.SafeHandler(m.RegisterHTMLHandler(adaptor));
  const input = new m.TeX({
    packages,
    maxBuffer: 20000,
    maxMacros: 1000,
    tags: 'none',
    formatError: (_jax, error) => { throw error; },
  });
  const output = new m.SVG({ fontCache: 'none', mtextInheritFont: false, unknownFamily: 'serif' });
  const document = m.mathjax.document('', {
    InputJax: input,
    OutputJax: output,
    safeOptions: { allow: { URLs: 'none', classes: 'safe', cssIDs: 'safe', styles: 'none' } },
  });
  return adaptor.outerHTML(document.convert(latex, { display: true }));
}

assert.match(convert(expectedDefault, String.raw`\ce{H2O}+\braket{\phi|\psi}`), /<svg/u);
assert.throws(() => convert(expectedDefault, String.raw`\qty{x}`));
assert.match(convert([...expectedDefault, 'physics'], String.raw`\qty{x}`), /<svg/u);
assert.match(convert(expectedDefault.filter((name) => name !== 'color').concat('colorv2'), String.raw`\color{red}{x}`), /<svg/u);
assert.match(convert([...expectedDefault, 'physics', 'setoptions'], String.raw`\setOptions[physics]{italicdiff=true}\qty{x}`), /<svg/u);
console.log('vendor package checks passed');
