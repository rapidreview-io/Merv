import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

const root = new URL('../', import.meta.url).pathname;
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : [];
  });
}

const researchTables =
  /\b(?:FROM|JOIN|UPDATE|INTO|TABLE|REFERENCES)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:code_units|code_review_acceptances|code_bases|code_publications|code_proposals|wf_instances|wf_leases)\b/i;

test('Code runtime neither imports research nor queries research-owned records', () => {
  for (const path of sources(join(root, 'packages/code/src'))) {
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(source, /(?:from\s*|import\s*\()\s*['"]@merv\/code-work(?:\/|['"])/, path);
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
        const value = ts.isTemplateExpression(node) ? node.getText(ast) : node.text;
        if (/\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|REFERENCES|JOIN|FROM)\b/i.test(value)) {
          assert.doesNotMatch(value, researchTables, `${path}: ${value.slice(0, 160)}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    assert.doesNotMatch(
      source,
      /\b(?:CodeUnitAcceptance|CodeUnitAcceptInput|CodeBaseRecord|CodeBaseStatus|CodeCheckSpec|CodeStoreLimits|CODE_CHECK_SLACK_SECONDS|CODE_CHECK_SOURCE_MAX_BYTES|WorkflowDefinition|WorkflowProvidedBlockerInput)\b/,
      path,
    );
  }
});

test('technical contract modules do not import research policy', () => {
  for (const name of ['code.ts', 'code-models.ts', 'code-units.ts', 'code-store.ts']) {
    const source = readFileSync(join(root, 'packages/contracts/src', name), 'utf8');
    assert.doesNotMatch(
      source,
      /from ['"]\.\/(?:workflow-guidance|code-publication-models)\.js['"]/,
      name,
    );
    assert.doesNotMatch(
      source,
      /\b(?:reviewRef|submissionRef|acceptanceHash|resolutionTaskId|successStates|codeCheckSpecSchema)\b/,
      name,
    );
  }
});

test('research composes core services without inheriting their implementation', () => {
  for (const path of sources(join(root, 'packages/code-work/src'))) {
    const source = readFileSync(path, 'utf8');
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const coreImports = new Set<string>();
    for (const node of ast.statements) {
      if (
        !ts.isImportDeclaration(node) ||
        !ts.isStringLiteral(node.moduleSpecifier) ||
        !node.moduleSpecifier.text.startsWith('@merv/code/')
      )
        continue;
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings))
        for (const binding of bindings.elements) coreImports.add(binding.name.text);
      if (node.importClause?.name) coreImports.add(node.importClause.name.text);
    }
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node))
        for (const clause of node.heritageClauses ?? [])
          if (clause.token === ts.SyntaxKind.ExtendsKeyword)
            for (const base of clause.types)
              assert.ok(
                !coreImports.has(base.expression.getText(ast)),
                `${path} extends core implementation`,
              );
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
});
