/**
 * The folder picker's path arithmetic.
 *
 * The picker used to be a flat list of the workspace root's children, so it never needed to know how
 * a path is shaped. Descending into folders does: the breadcrumb, the "up one level" row and the
 * folder's own name are all derived from the path string, and getting them wrong would either strand
 * the user at a root that cannot be left or send them somewhere outside the workspace.
 *
 * The server owns the walk. Explicit computer browsing may climb to the filesystem root;
 * this only covers turning a path back into its parts.
 */
import { describe, expect, test } from 'bun:test';
import {
  breadcrumbPath,
  directoryName,
  directoryScopeForPath,
  isPathWithinWorkspace,
  parentPath,
  pathSegments,
} from '../src/components/ProjectPicker';

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
    expect(parentPath('/home')).toBe('/');
    expect(parentPath('C:/Users/alex')).toBe('C:/Users');
    expect(parentPath('C:/Users')).toBe('C:/');
    expect(parentPath('C:/')).toBeNull();
    expect(parentPath('/')).toBeNull();
  });
});

describe('breadcrumbPath', () => {
  test('drive breadcrumbs open the absolute drive root, not a drive-relative path', () => {
    expect(breadcrumbPath('C:/Users/alex', 0)).toBe('C:/');
    expect(breadcrumbPath('C:/Users/alex', 1)).toBe('C:/Users');
    expect(breadcrumbPath('C:/Users/alex', 2)).toBe('C:/Users/alex');
    expect(breadcrumbPath('D:\\Work\\project', 0)).toBe('D:/');
  });

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

describe('directoryScopeForPath', () => {
  test('keeps workspace scope inside the workspace root and only uses computer scope outside it', () => {
    expect(isPathWithinWorkspace('/workspace', '/workspace')).toBe(true);
    expect(isPathWithinWorkspace('/workspace/atlas', '/workspace/')).toBe(true);
    expect(isPathWithinWorkspace('/workspace-other', '/workspace')).toBe(false);
    expect(isPathWithinWorkspace('/Volumes/Studio', '/workspace')).toBe(false);

    expect(directoryScopeForPath('', '/workspace')).toBe('workspace');
    expect(directoryScopeForPath('/workspace', '/workspace')).toBe('workspace');
    expect(directoryScopeForPath('/workspace/escape-symlink', '/workspace')).toBe('workspace');
    expect(directoryScopeForPath('/workspace/../etc', '/workspace')).toBe('workspace');
    expect(directoryScopeForPath('/workspace', undefined)).toBe('workspace');
    expect(directoryScopeForPath('/Volumes/Studio', '/workspace')).toBe('computer');
    expect(directoryScopeForPath('/workspace-other', '/workspace')).toBe('computer');
  });
});
