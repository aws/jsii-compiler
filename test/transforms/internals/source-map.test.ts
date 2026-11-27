import { insertIntoEmittedJs, Insertion } from '../../../src/transforms/source-map';

const TEXT = 'const a = 1;\nconst b = 2;\nclass C {\n  m() { return a; }\n}\nexports.C = C;\n';
const MAPPINGS =
  'AAAA,KAAK,CAAC,GAAG,CAAC;AACf,KAAK,CAAC,GAAG,CAAC;AACf,MAAM,CAAC;IACV,CAAC,KAAK,MAAM;AACjB;AACA,OAAO,CAAC,CAAC,GAAG,CAAC';

/** `.js` text with an inline source map, edited, and the text and `mappings` that come out. */
function edit(insertions: Insertion[]): { text: string; mappings: string } {
  const json = JSON.stringify({ version: 3, file: 'a.js', sources: ['a.ts'], names: [], mappings: MAPPINGS });
  const url = `data:application/json;base64,${Buffer.from(json).toString('base64')}`;
  const result = insertIntoEmittedJs('a.js', `${TEXT}//# sourceMappingURL=${url}\n`, insertions);
  const [text, base64] = result.split('\n//# sourceMappingURL=data:application/json;base64,');
  return { text, mappings: JSON.parse(Buffer.from(base64, 'base64').toString('utf-8')).mappings };
}

// Expected: what decoding every line, applying the edits and encoding every line gives.
test.each<[string, Insertion[], string, string]>([
  [
    'a one-line insertion',
    [{ offset: 42, text: '/* x */ ' }],
    'const a = 1;\nconst b = 2;\nclass C {\n  m() /* x */ { return a; }\n}\nexports.C = C;',
    'AAAA,KAAK,CAAC,GAAG,CAAC;AACf,KAAK,CAAC,GAAG,CAAC;AACf,MAAM,CAAC;IACV,CAAC,aAAK,MAAM;AACjB;AACA,OAAO,CAAC,CAAC,GAAG,CAAC',
  ],
  [
    'an insertion with new lines',
    [{ offset: 36, text: '  static x = 1;\n\n' }],
    'const a = 1;\nconst b = 2;\nclass C {\n  static x = 1;\n\n  m() { return a; }\n}\nexports.C = C;',
    'AAAA,KAAK,CAAC,GAAG,CAAC;AACf,KAAK,CAAC,GAAG,CAAC;AACf,MAAM,CAAC;;;IACV,CAAC,KAAK,MAAM;AACjB;AACA,OAAO,CAAC,CAAC,GAAG,CAAC',
  ],
  [
    'edits on the same line, and on separate lines',
    [
      { offset: 4, text: 'XX' },
      { offset: 9, text: 'Y' },
      { offset: 26, text: '"use strict";\n' },
    ],
    'consXXt a =Y 1;\nconst b = 2;\n"use strict";\nclass C {\n  m() { return a; }\n}\nexports.C = C;',
    'AAAA,OAAK,CAAC,IAAG,CAAC;AACf,KAAK,CAAC,GAAG,CAAC;;AACf,MAAM,CAAC;IACV,CAAC,KAAK,MAAM;AACjB;AACA,OAAO,CAAC,CAAC,GAAG,CAAC',
  ],
  [
    'a deletion across lines (the segments after it are relative to another one)',
    [{ offset: 13, length: 13, text: '' }],
    'const a = 1;\nclass C {\n  m() { return a; }\n}\nexports.C = C;',
    'AAAA,KAAK,CAAC,GAAG,CAAC;AAEpB,MAAM,CAAC;IACV,CAAC,KAAK,MAAM;AACjB;AACA,OAAO,CAAC,CAAC,GAAG,CAAC',
  ],
  [
    'a deletion that is replaced',
    [
      { offset: 38, length: 20, text: 'n() {\n  }' },
      { offset: 58, text: '// done\n' },
    ],
    'const a = 1;\nconst b = 2;\nclass C {\n  n() {\n  }// done\nexports.C = C;',
    'AAAA,KAAK,CAAC,GAAG,CAAC;AACf,KAAK,CAAC,GAAG,CAAC;AACf,MAAM,CAAC;;;AAGf,OAAO,CAAC,CAAC,GAAG,CAAC',
  ],
])('edits to a source map: %s', (_name, insertions, text, mappings) => {
  expect(edit(insertions)).toEqual({ text, mappings });
});
