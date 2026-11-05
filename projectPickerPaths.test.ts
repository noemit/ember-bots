/**
 * The folder picker's path arithmetic.
 *
 * The picker used to be a flat list of the workspace root's children, so it never needed to know how
 * a path is shaped. Descending into folders does: the breadcrumb, the "up one level" row and the
 * folder's own name are all derived from the path string, and getting them wrong would either strand
 * the user at a root that cannot be left or send them somewhere outside the workspace.
 *
 * The server owns the walk (it refuses `?path=` outside the root); this only covers turning a path
 * back into its parts.
 */
import { describe, expect, test } from 'bun:test';
import { breadcrumbPath, directoryName, parentPath, pathSegments } from './src/components/ProjectPicker';

describe('pathSegments', () => {
  test('keeps the leading slash as its own segment', () => {
    expect(pathSegments('/home/em/workspace/ember')).toEqual(['/', 'home', 'em', 'workspace', 'ember']);
  });

  test('a root path is just the slash', () => {
    expect(pathSegments('/')).toEqual(['/']);
  });

  test('ignores a trailing slash and repeated separators', () => {
    expect(pathSegments('/home/em/')).toEqual(['/', 'home', 'em']);
    expect(pathSegments('/home//em')).toEqual(['/', 'home', 'em']);
  });
});

describe('parentPath', () => {
  test('climbs one level', () => {
    expect(parentPath('/home/em/workspace/ember')).toBe('/home/em/workspace');
    expect(parentPath('/home/em/workspace')).toBe('/home/em');
  });

  test('the root has no parent, so "Up one level" is not drawn there', () => {
    expect(parentPath('/home')).toBeNull();
    expect(parentPath('/')).toBeNull();
  });
});

describe('breadcrumbPath', () => {
  test('each crumb points at the folder it names, never doubling the leading slash', () => {
    expect(breadcrumbPath('/home/em/workspace/ember', 0)).toBe('/home');
    expect(breadcrumbPath('/home/em/workspace/ember', 1)).toBe('/home/em');
    expect(breadcrumbPath('/home/em/workspace/ember', 2)).toBe('/home/em/workspace');
    expect(breadcrumbPath('/home/em/workspace/ember', 3)).toBe('/home/em/workspace/ember');
  });
});

describe('directoryName', () => {
  test('is the last segment, which is what the row and the breadcrumb show', () => {
    expect(directoryName('/home/em/workspace/ember')).toBe('ember');
    expect(directoryName('/home/em/workspace/ember/')).toBe('ember');
  });
});
