import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getStaticTOMLValue, parseTOML, type AST } from 'toml-eslint-parser';
import { writeConfigFile } from './config.js';

interface TextEdit {
  start: number;
  end: number;
  text: string;
}

function keyParts(key: AST.TOMLKey): string[] {
  return key.keys.map(part => part.type === 'TOMLBare' ? part.name : part.value);
}

function setEnvironment(
  source: string,
  ast: AST.TOMLProgram,
  namespace: string[],
  environment: Record<string, string>,
): string {
  const values = new Map(Object.entries(environment));
  const edits: TextEdit[] = [];
  let container: { key: string[]; node: AST.TOMLTopLevelTable | AST.TOMLTable | AST.TOMLInlineTable } = {
    key: [], node: ast.body[0],
  };
  const visit = (node: typeof container.node, key: string[]): void => {
    if (key.length > container.key.length && key.every((part, index) => part === namespace[index])) {
      container = { key, node };
    }
    for (const child of node.body) {
      if (child.type === 'TOMLTable') {
        if (child.kind === 'standard') {
          visit(child, keyParts(child.key));
        }
        continue;
      }
      const childKey = [...key, ...keyParts(child.key)];
      const name = childKey.at(-1);
      if (name && childKey.length === namespace.length + 1 &&
        namespace.every((part, index) => part === childKey[index]) && values.has(name)) {
        const value = values.get(name);
        const [start, end] = child.value.range;
        edits.push({ start, end, text: JSON.stringify(value) });
        values.delete(name);
      } else if (child.value.type === 'TOMLInlineTable') {
        visit(child.value, childKey);
      }
    }
  };
  visit(ast.body[0], []);

  if (values.size) {
    const prefix = namespace.slice(container.key.length);
    const assignments = [...values].map(([name, value]) => `${[...prefix, name].join('.')} = ${JSON.stringify(value)}`);
    const node = container.node;
    if (node.type === 'TOMLInlineTable') {
      const last = node.body.at(-1);
      const position = last ? last.range[1] : node.range[0] + 1;
      edits.push({ start: position, end: position, text: (last ? ', ' : '') + assignments.join(', ') });
    } else {
      const newline = source.includes('\r\n') ? '\r\n' : '\n';
      const lastAssignment = node.body.filter(child => child.type === 'TOMLKeyValue').at(-1);
      const end = lastAssignment?.range[1] ?? (node.type === 'TOMLTable' ? node.range[1] : 0);
      const lineEnd = end ? source.indexOf('\n', end) : -1;
      const position = lineEnd < 0 ? (end ? source.length : 0) : lineEnd + 1;
      const leading = end && lineEnd < 0 ? newline : '';
      edits.push({ start: position, end: position, text: leading + assignments.join(newline) + newline });
    }
  }

  return edits.sort((a, b) => b.start - a.start).reduce(
    (result, edit) => result.slice(0, edit.start) + edit.text + result.slice(edit.end),
    source,
  );
}

export function mergeCodexEnvironment(
  server: string,
  matches: (value: unknown) => boolean,
  environment: Record<string, string>,
): void {
  const file = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
  if (!fs.existsSync(file)) {
    throw new Error(`The Codex registration is outside ${file}. Configure its export environment in the source configuration.`);
  }
  const source = fs.readFileSync(file, 'utf8');
  const ast = parseTOML(source);
  const config = getStaticTOMLValue(ast);
  const registrations = config.mcp_servers;
  if (!registrations || typeof registrations !== 'object' || Array.isArray(registrations) || registrations instanceof Date ||
    !matches(registrations[server])) {
    throw new Error(`The existing Codex registration in ${file} does not point to this checkout. Configure the export environment in the source configuration.`);
  }
  const updated = setEnvironment(source, ast, ['mcp_servers', server, 'env'], environment);
  parseTOML(updated);
  if (fs.readFileSync(file, 'utf8') !== source) {
    throw new Error(`Codex configuration changed during setup. Retry with the current configuration at ${file}.`);
  }
  writeConfigFile(file, updated);
}
