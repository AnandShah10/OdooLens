import * as path from 'path';
// Intentional require() rather than `import * as Parser`: web-tree-sitter's CJS module shape
// doesn't interop cleanly with an ES import here (its default export is the Parser class).
const Parser = require('web-tree-sitter');

let initialized: Promise<void> | null = null;
let language: any = null;

/**
 * Lazily initializes web-tree-sitter and loads the Python grammar.
 * This is the ONLY place that should require('web-tree-sitter') directly;
 * everything else in the extension consumes `parsePython`.
 */
async function ensureInit(extensionRoot: string): Promise<void> {
  if (!initialized) {
    initialized = (async () => {
      await Parser.init({
        locateFile: (fileName: string) => {
          if (fileName === 'tree-sitter.wasm') {
            return path.join(extensionRoot, 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm');
          }
          return fileName;
        },
      });
      language = await Parser.Language.load(
        path.join(extensionRoot, 'node_modules', 'tree-sitter-wasms', 'out', 'tree-sitter-python.wasm')
      );
    })();
  }
  return initialized;
}

export interface ParsedPython {
  tree: any; // web-tree-sitter Tree
  source: string;
}

export async function parsePython(source: string, extensionRoot: string): Promise<ParsedPython> {
  await ensureInit(extensionRoot);
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  return { tree, source };
}

/** Reset cached init state — used only by tests that need a fresh module root. */
export function _resetForTests(): void {
  initialized = null;
  language = null;
}
