import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skipped = new Set(['.git', 'node_modules', '.local', '.state', 'coverage', 'test-results', 'playwright-report']);
const files = [];
const findings = [];
function visit(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skipped.has(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (entry.isSymbolicLink()) findings.push({ file: relative, code: 'SYMLINK_IN_PUBLIC_TREE' });
    else if (entry.isDirectory()) visit(absolute);
    else if (entry.isFile()) files.push({ absolute, relative });
  }
}
visit(root);
const disallowedPath = /(^|\/)(?:core|server|web|artifacts|local-data|data\/decks|profiles)(?:\/|$)/;
const sourceModules = [];
const dynamicImports = [];
const auditedDynamicImports = new Map([
  ['tools/keyteki-human-launcher.mjs:BROWSER_MODULE', 'Package-local browser-provider URL from human-config'],
  ['tools/keyteki-human-create-public.mjs:BROWSER_MODULE', 'Package-local browser-provider URL from human-config'],
  ['tools/keyteki-browser-bridge.mjs:pathToFileURL(path.resolve(config.providerModule)).href', 'Explicit operator-supplied model extension; no private default'],
  ['tools/keyteki-browser-bridge.mjs:pathToFileURL(path.resolve(config.social.providerModule)).href', 'Explicit operator-supplied social extension; disabled by default'],
]);
const auditedDynamicRequires = new Map([
  ["tools/freeze-keyteki-live.mjs:name+'/package.json'", 'Production dependency names from package manifests; collector requires package-local node_modules, no symlinks or outside paths'],
]);
const dynamicRequires = [];
const secrets = [
  ['PRIVATE_KEY', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['GITHUB_TOKEN', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['REAL_LOCAL_HOME', /\/home\/[a-zA-Z0-9_.-]+\/(?:\.openclaw|\.cache|repos|node_modules|workspace)/],
  ['PRIVATE_WINDOWS_PATH', /[CF]:\\(?:Users|repos|udg)\\/i],
];
for (const { absolute, relative } of files) {
  if (disallowedPath.test(relative)) findings.push({ file: relative, code: 'EXCLUDED_REPLICA_OR_DATA_PATH' });
  if (/\.(?:gz|zip|sqlite3?|db|png|jpg|webp|bin|tgz)$/i.test(relative)) findings.push({ file: relative, code: 'UNREVIEWED_BINARY_OR_ARCHIVE' });
  if (/^\.env(?:\.|$)/.test(relative) || /(?:^|\/)credentials\.json$/.test(relative)) findings.push({ file: relative, code: 'LOCAL_CONFIGURATION_IN_PUBLIC_TREE' });
  const data = fs.readFileSync(absolute);
  if (data.includes(0)) { findings.push({ file: relative, code: 'BINARY_FILE' }); continue; }
  const text = data.toString('utf8');
  for (const [code, pattern] of secrets) if (pattern.test(text)) findings.push({ file: relative, code });
  if (!/\.(?:[cm]?js|ts)$/.test(relative) || relative.endsWith('.d.ts')) continue;
  const ast = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true);
  const requireNames = new Set(['require']);
  const createRequireNames = new Set(['createRequire']);
  for (const statement of ast.statements) {
    if (ts.isImportDeclaration(statement) && statement.moduleSpecifier.text === 'node:module') {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) {
        if ((binding.propertyName?.text ?? binding.name.text) === 'createRequire') createRequireNames.add(binding.name.text);
      }
    }
  }
  function findRequireAliases(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression) && createRequireNames.has(node.initializer.expression.text)) requireNames.add(node.name.text);
    ts.forEachChild(node, findRequireAliases);
  }
  findRequireAliases(ast);
  function inspect(node) {
    let specifier;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifier = node.moduleSpecifier.text;
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) specifier = node.arguments[0].text;
      else {
        const expression = node.arguments[0]?.getText(ast).replace(/\s+/g, '') ?? '';
        const audit = auditedDynamicImports.get(relative + ':' + expression);
        dynamicImports.push({ file: relative, line: ast.getLineAndCharacterOfPosition(node.pos).line + 1, expression, audit: audit ?? null });
        if (!audit) findings.push({ file: relative, code: 'UNAUDITED_DYNAMIC_IMPORT' });
      }
    }
    if (ts.isCallExpression(node) && (
      (ts.isIdentifier(node.expression) && requireNames.has(node.expression.text)) ||
      (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'resolve' && ts.isIdentifier(node.expression.expression) && requireNames.has(node.expression.expression.text))
    )) {
      if (node.arguments.length && ts.isStringLiteral(node.arguments[0])) specifier = node.arguments[0].text;
      else {
        const expression = node.arguments[0]?.getText(ast).replace(/\s+/g, '') ?? '';
        const audit = auditedDynamicRequires.get(relative + ':' + expression);
        dynamicRequires.push({ file: relative, line: ast.getLineAndCharacterOfPosition(node.pos).line + 1, expression, audit: audit ?? null });
        if (!audit) findings.push({ file: relative, code: 'UNAUDITED_DYNAMIC_REQUIRE' });
      }
    }
    if (specifier) {
      sourceModules.push({ file: relative, specifier });
      if (/(?:^|\/)core(?:\/|$)|external-keyteki|headless-game|local-room/.test(specifier)) findings.push({ file: relative, code: 'FORBIDDEN_RUNTIME_IMPORT' });
      if (specifier.startsWith('/') || specifier.startsWith('file:')) findings.push({ file: relative, code: 'ABSOLUTE_RUNTIME_IMPORT' });
      if (specifier.startsWith('.')) {
        const resolved = path.resolve(path.dirname(absolute), specifier);
        const inside = resolved.startsWith(root + path.sep);
        const alternate = resolved.endsWith('.js') ? resolved.slice(0, -3) + '.ts' : resolved;
        if (!inside) findings.push({ file: relative, code: 'IMPORT_OUTSIDE_PACKAGE' });
        else if (!fs.existsSync(resolved) && !fs.existsSync(alternate)) findings.push({ file: relative, code: 'MISSING_RELATIVE_IMPORT', specifier });
      }
    }
    ts.forEachChild(node, inspect);
  }
  inspect(ast);
}
const report = { schema: 'keyforge-tco-public-boundary-v1', files: files.length, moduleEdges: sourceModules.length, dynamicImports, dynamicRequires, findings };
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
if (findings.length) process.exitCode = 1;
