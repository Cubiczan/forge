import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveWithinBase, ToolExecutorImpl } from '../src/tools/index.ts';

describe('resolveWithinBase', () => {
  const base = '/workspace/project';

  test('allows relative in-tree paths', () => {
    expect(resolveWithinBase('src/index.ts', base)).toBe(
      path.resolve(base, 'src/index.ts'),
    );
    expect(resolveWithinBase('./package.json', base)).toBe(
      path.resolve(base, 'package.json'),
    );
    expect(resolveWithinBase('.', base)).toBe(path.resolve(base));
  });

  test('allows absolute paths that stay inside the base', () => {
    const inTree = path.join(base, 'forge.yaml');
    expect(resolveWithinBase(inTree, base)).toBe(path.resolve(inTree));
  });

  test('rejects parent and nested traversal', () => {
    expect(() => resolveWithinBase('..', base)).toThrow(/escapes allowed directory/);
    expect(() => resolveWithinBase('../secret', base)).toThrow(
      /escapes allowed directory/,
    );
    expect(() => resolveWithinBase('src/../../etc/passwd', base)).toThrow(
      /escapes allowed directory/,
    );
  });

  test('rejects absolute paths outside the base', () => {
    expect(() => resolveWithinBase('/etc/passwd', base)).toThrow(
      /escapes allowed directory/,
    );
  });

  test('rejects null bytes', () => {
    expect(() => resolveWithinBase('file.txt\0../etc/passwd', base)).toThrow(
      /Invalid path/,
    );
  });
});

describe('ToolExecutorImpl path confinement', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function sandbox(): { root: string; tools: ToolExecutorImpl } {
    const root = mkdtempSync(path.join(tmpdir(), 'forge-tools-'));
    dirs.push(root);
    writeFileSync(path.join(root, 'in-tree.txt'), 'hello from tree\n');
    mkdirSync(path.join(root, 'nested'), { recursive: true });
    writeFileSync(path.join(root, 'nested', 'file.ts'), 'export const ok = 1;\n');
    return { root, tools: new ToolExecutorImpl({ baseDir: root }) };
  }

  test('file_read returns in-tree contents', async () => {
    const { tools } = sandbox();
    const result = await tools.execute('file_read', { path: 'in-tree.txt' });
    expect(result.success).toBe(true);
    expect(result.output).toBe('hello from tree\n');
  });

  test('file_read allows nested and absolute in-tree paths', async () => {
    const { root, tools } = sandbox();
    const relative = await tools.execute('file_read', { path: 'nested/file.ts' });
    expect(relative.success).toBe(true);
    expect(relative.output).toContain('export const ok');

    const absolute = await tools.execute('file_read', {
      path: path.join(root, 'in-tree.txt'),
    });
    expect(absolute.success).toBe(true);
    expect(absolute.output).toBe('hello from tree\n');
  });

  test('file_read rejects traversal and out-of-tree paths', async () => {
    const { tools } = sandbox();

    const parent = await tools.execute('file_read', { path: '../in-tree.txt' });
    expect(parent.success).toBe(false);
    expect(parent.error).toMatch(/escapes allowed directory/);

    const etc = await tools.execute('file_read', { path: '/etc/passwd' });
    expect(etc.success).toBe(false);
    expect(etc.error).toMatch(/escapes allowed directory/);

    const nested = await tools.execute('file_read', {
      path: 'nested/../../../../../../etc/passwd',
    });
    expect(nested.success).toBe(false);
    expect(nested.error).toMatch(/escapes allowed directory/);
  });

  test('file_write stays inside the base and rejects escape', async () => {
    const { root, tools } = sandbox();

    const ok = await tools.execute('file_write', {
      path: 'nested/out.txt',
      content: 'written',
    });
    expect(ok.success).toBe(true);
    expect(await Bun.file(path.join(root, 'nested', 'out.txt')).text()).toBe(
      'written',
    );

    const escape = await tools.execute('file_write', {
      path: '../pwned.txt',
      content: 'nope',
    });
    expect(escape.success).toBe(false);
    expect(escape.error).toMatch(/escapes allowed directory/);
    expect(Bun.file(path.join(root, '..', 'pwned.txt')).size).toBe(0);
  });
});
