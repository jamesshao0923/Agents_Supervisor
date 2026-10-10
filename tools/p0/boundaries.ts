import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

export async function checkBoundaries(root: string): Promise<string[]> {
  const issues: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return [];
      throw e;
    });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) { issues.push(`Source symlink is not supported: ${path}`); continue; }
      if (entry.isDirectory()) { await walk(path); continue; }
      if (!/\.(?:ts|tsx|mts|cts)$/.test(path)) continue;
      const name = relative(root, path).replaceAll('\\', '/');
      const file = ts.createSourceFile(name, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node): void {
        let specifier: string | undefined;
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          specifier = node.moduleSpecifier.text;
        } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
          const arg = node.moduleReference.expression;
          specifier = arg && ts.isStringLiteral(arg) ? arg.text : '<dynamic>';
        } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
          specifier = node.argument.literal.text;
        } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
          const arg = node.arguments[0];
          specifier = arg && ts.isStringLiteral(arg) ? arg.text : '<dynamic>';
        }
        if (specifier !== undefined) {
          const destination = specifier.startsWith('.') ? relative(root, resolve(dir, specifier)).replaceAll('\\', '/') : specifier;
          if (name.startsWith('packages/domain/') && !destination.startsWith('packages/domain/') && !destination.startsWith('packages/contracts/')) {
            issues.push(`${name}: domain cannot import ${specifier}`);
          }
          if (name.startsWith('tools/p0/') && (destination.startsWith('apps/') || destination.startsWith('packages/'))) {
            issues.push(`${name}: development verifier cannot depend on product implementation ${specifier}`);
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(file);
    }
  }
  for (const dir of ['apps', 'packages', 'tools']) await walk(join(root, dir));
  return issues;
}
