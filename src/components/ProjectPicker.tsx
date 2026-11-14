import * as React from 'react';
import { ArrowLeft, ArrowUp, Check, ChevronDown, ChevronRight, FolderOpen, Loader2, Search } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { piCreateDirectory, piLoadDirectories, type PiDirectory } from '../piApi';
import type { Instance, Project } from '../types';

export const pathSegments = (path: string): string[] =>
  path.split(/[\\/]/).reduce<string[]>((segments, part, index) => {
    if (index === 0 && part === '') return ['/'];
    if (part) segments.push(part);
    return segments;
  }, []);

export const parentPath = (path: string): string | null => {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized || /^[A-Za-z]:$/.test(normalized)) return null;
  const index = normalized.lastIndexOf('/');
  if (index < 0) return null;
  const parent = normalized.slice(0, index);
  return !parent ? '/' : /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent;
};
export const breadcrumbPath = (path: string, upTo: number): string => {
  const joined = pathSegments(path).filter((segment) => segment !== '/').slice(0, upTo + 1).join('/');
  return path.startsWith('/') ? `/${joined}` : /^[A-Za-z]:$/.test(joined) ? `${joined}/` : joined;
};
export const directoryName = (path: string): string => pathSegments(path).at(-1) ?? path;

type Props = {
  instance: Instance;
  projects: Project[];
  recentDirectories?: string[];
  projectUsage?: Array<{ path: string; count: number; lastUsed: number }>;
  value: string;
  workspace?: string;
  onWorkspaceChange: (directory: string) => void;
  onSelect: (directory: string) => void;
  /** New-chat callers can focus their composer after the picker finishes closing. */
  onAfterSelect?: () => void;
  workspaceOnly?: boolean;
  disabled?: boolean;
};

/** Search known projects first; browsing only opens folders until explicitly confirmed. */
export default function ProjectPicker(props: Props) {
  const [open, setOpen] = React.useState(false);
  const escapeRef = React.useRef<(() => void) | null>(null);
  const selectedRef = React.useRef(false);
  const { workspaceOnly, workspace, value, disabled } = props;
  return <Popover open={open} onOpenChange={(next) => { if (next) selectedRef.current = false; setOpen(next); }}>
    <PopoverTrigger asChild><Button type="button" variant="ghost" size="sm" disabled={disabled}
      className="h-auto min-h-8 min-w-0 max-w-[300px] gap-2 px-2 py-1 text-xs font-normal"
      aria-label={workspaceOnly ? 'Choose workspace' : 'New bot project'} title={workspaceOnly ? workspace : value}>
      <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="whitespace-normal text-left [overflow-wrap:anywhere]">{workspaceOnly ? (workspace ? directoryName(workspace) : 'Choose workspace') : value ? directoryName(value) : 'Choose project'}</span>
      <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
    </Button></PopoverTrigger>
    <PopoverContent align="start" side="top" aria-label={workspaceOnly ? 'Choose your workspace' : 'Find a project'}
      onEscapeKeyDown={(event) => { event.preventDefault(); escapeRef.current?.(); }}
      onCloseAutoFocus={(event) => {
        if (selectedRef.current && props.onAfterSelect) { event.preventDefault(); props.onAfterSelect(); }
        selectedRef.current = false;
      }}
      className="flex max-h-[min(720px,var(--radix-popover-content-available-height))] w-[min(600px,calc(100vw-2rem))] flex-col overflow-y-auto p-0">
      {open ? <PickerContent key={props.instance.id} {...props} onSelect={(directory) => { selectedRef.current = true; props.onSelect(directory); }} escapeRef={escapeRef} onClose={() => setOpen(false)} /> : null}
    </PopoverContent>
  </Popover>;
}

function PickerContent({ instance, projects, recentDirectories = [], projectUsage, value, workspace, onWorkspaceChange, onSelect, workspaceOnly = false, onClose, escapeRef }: Props & {
  onClose: () => void;
  escapeRef: React.RefObject<(() => void) | null>;
}) {
  const [mode, setMode] = React.useState<'search' | 'browse' | 'workspace'>(workspaceOnly ? 'workspace' : 'search');
  const [path, setPath] = React.useState(workspace ?? '');
  const [query, setQuery] = React.useState('');
  const [moreFrequent, setMoreFrequent] = React.useState(false);
  const [moreRecent, setMoreRecent] = React.useState(false);
  const [form, setForm] = React.useState<'path' | 'new' | null>(null);
  const [typed, setTyped] = React.useState('');
  const [listing, setListing] = React.useState<{ path: string; directories: PiDirectory[] } | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [retry, setRetry] = React.useState(0);
  const [creating, setCreating] = React.useState(false);
  const [createFailed, setCreateFailed] = React.useState(false);
  const searchInput = React.useRef<HTMLInputElement>(null);
  const folderTitle = React.useRef<HTMLHeadingElement>(null);
  const pathOpener = React.useRef<HTMLButtonElement>(null);
  const newFolderOpener = React.useRef<HTMLButtonElement>(null);
  const restoreFormFocus = React.useRef<'path' | 'new' | null>(null);
  const alive = React.useRef(true);
  const request = React.useRef(0);
  const canBrowse = instance.kind === 'pi';
  const browsing = mode !== 'search';

  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  React.useEffect(() => {
    if (!canBrowse || !browsing) return;
    let cancelled = false;
    setLoading(true); setFailed(false); setListing(null);
    void piLoadDirectories(instance.id, path || undefined, 'computer').catch(() => null).then((result) => {
      if (cancelled) return;
      setLoading(false); setFailed(!result); setListing(result);
    });
    return () => { cancelled = true; };
  }, [instance.id, canBrowse, browsing, path, retry]);

  const navigate = (next: string) => {
    request.current++;
    setCreating(false);
    setListing(null); setLoading(canBrowse); setFailed(false); setPath(next);
    // Reopening the current breadcrumb/path must still settle the cleared listing.
    setRetry((version) => version + 1);
    setForm(null); setCreateFailed(false);
  };
  const back = () => { request.current++; setCreating(false); setMode('search'); setForm(null); setCreateFailed(false); };
  React.useEffect(() => {
    if (browsing) folderTitle.current?.focus();
    else searchInput.current?.focus();
  }, [browsing, path]);
  const cancelForm = () => {
    restoreFormFocus.current = form;
    request.current++; setCreating(false); setForm(null); setCreateFailed(false);
  };
  React.useEffect(() => {
    if (form || !restoreFormFocus.current) return;
    const opener = restoreFormFocus.current === 'path' ? pathOpener : newFolderOpener;
    restoreFormFocus.current = null;
    opener.current?.focus();
  }, [form]);
  React.useEffect(() => {
    escapeRef.current = () => {
      if (form) cancelForm();
      else if (browsing && !workspaceOnly) back();
      else if (query) { setQuery(''); searchInput.current?.focus(); }
      else onClose();
    };
    return () => { escapeRef.current = null; };
  });

  const currentPath = listing?.path ?? path;
  const parent = parentPath(currentPath);
  const choose = () => {
    if (mode === 'workspace') onWorkspaceChange(currentPath);
    else onSelect(currentPath);
    onClose();
  };
  // Fallbacks describe known locations, never invented usage counts or browse activity.
  const known = new Map<string, { path: string; count: number; lastUsed: number }>();
  projects.forEach((project) => { if (project.path) known.set(project.path, { path: project.path, count: 0, lastUsed: projectUsage ? 0 : project.lastOpenedAt ?? 0 }); });
  recentDirectories.forEach((directory, index) => {
    if (directory) known.set(directory, { path: directory, count: 0, lastUsed: projectUsage ? 0 : known.get(directory)?.lastUsed || recentDirectories.length - index });
  });
  if (value && !known.has(value)) known.set(value, { path: value, count: 0, lastUsed: 0 });
  projectUsage?.forEach((usage) => { if (usage.path) known.set(usage.path, usage); });
  const comparePath = (a: { path: string }, b: { path: string }) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  const usagePaths = new Set(projectUsage?.map((item) => item.path));
  const frequent = [...known.values()].filter((item) => projectUsage ? usagePaths.has(item.path) && item.count > 0 : true).sort((a, b) => b.count - a.count || comparePath(a, b));
  const recent = [...known.values()].filter((item) => projectUsage ? usagePaths.has(item.path) && item.lastUsed > 0 : true).sort((a, b) => b.lastUsed - a.lastUsed || comparePath(a, b));
  const results = [...known.values()].filter((row) => row.path.toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => b.count - a.count || comparePath(a, b));
  const openProject = (directory: string) => { navigate(directory); if (mode !== 'workspace') setMode('browse'); };
  const row = (directory: string, name = directoryName(directory), count?: number) => <button type="button" key={directory}
    disabled={creating} onClick={() => openProject(directory)}
    className="flex min-h-14 w-full items-center gap-3 border-b px-2 py-3 text-left text-sm transition-colors last:border-b-0 hover:bg-accent focus-visible:bg-accent focus-visible:outline-highlight disabled:opacity-50"
    aria-label={`Open folder ${directory}`}>
    <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
    <span className="min-w-0 flex-1"><span className="block whitespace-normal [overflow-wrap:anywhere]">{name}</span>
      <span className="mt-0.5 block whitespace-normal text-xs text-muted-foreground [overflow-wrap:anywhere]">{directory}</span>
      {count !== undefined && count > 0 ? <span className="mt-1 block text-[11px] text-muted-foreground">{count} {count === 1 ? 'chat started' : 'chats started'} / 30 days</span> : null}
    </span>
    {directory === value ? <Check className="size-3.5 shrink-0 text-highlight" /> : null}
    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
  </button>;
  const group = (title: string, rows: typeof frequent, expanded: boolean, toggle: () => void) => <section aria-label={`${title} projects`} className="min-w-0">
    <h3 className="border-b pb-2 text-xs font-medium">{title}<span className="mt-1 block text-[11px] font-normal text-muted-foreground">{projectUsage ? (title === 'Frequent' ? 'Most chats started · 30 days' : 'Last chat started') : 'Known locations · usage not available'}</span></h3>
    {!rows.length ? <p className="py-4 text-xs leading-relaxed text-muted-foreground">{title === 'Frequent' ? 'No chat starts recorded in the last 30 days.' : 'No chat start times recorded for these projects.'} Older hosts may not supply chat start times. Search known projects above or browse below.</p> : null}
    {(expanded ? rows : rows.slice(0, 5)).map((item) => row(item.path, directoryName(item.path), title === 'Frequent' ? item.count : undefined))}
    {rows.length > 5 ? <Button variant="ghost" size="sm" className="mt-1 text-xs" aria-label={`${expanded ? 'Show less' : 'Show more'} ${title.toLowerCase()} projects`} aria-expanded={expanded} onClick={toggle}>{expanded ? 'Show less' : `Show more (${rows.length - 5})`}</Button> : null}
  </section>;
  const validName = typed.trim() !== '' && !['.', '..'].includes(typed.trim()) && !/[\\/\0]/.test(typed);
  const duplicateName = listing?.directories.some((entry) => entry.name === typed.trim());
  return <div onKeyDown={(event) => {
    if (event.altKey && event.key === 'ArrowLeft' && browsing && parent && !creating) { event.preventDefault(); navigate(parent); }
  }}>
    <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
      <div><h2 className="text-sm font-medium">{mode === 'workspace' ? 'Choose your workspace' : browsing ? 'Browse folders' : 'Find a project'}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{instance.label} · {browsing ? 'Opening a folder does not select it' : 'All known locations on this host'}</p></div>
      {browsing && !workspaceOnly ? <Button size="sm" variant="ghost" onClick={back}><ArrowLeft className="size-3.5" />Back to search</Button> : null}
    </div>
    <div className="p-4">
      {!browsing ? <>
        <label className="mb-2 block text-xs" htmlFor={`project-search-${instance.id}`}>Search all known projects on {instance.label}</label>
        <div className="relative"><Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" /><Input ref={searchInput} id={`project-search-${instance.id}`} type="search" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Project name or full path…" className="min-h-11 pl-9" /></div>
        {query.trim() ? <section aria-label="Project search results" className="mt-5"><h3 className="mb-1 text-xs text-muted-foreground">{results.length} projects · all known locations</h3>{results.map((item) => row(item.path))}
          {!results.length ? <p className="py-5 text-xs leading-relaxed text-muted-foreground">No known projects match. Try another name or full path, or browse folders below.</p> : null}</section>
          : known.size ? <><div className="mt-5 grid grid-cols-1 gap-5 min-[560px]:grid-cols-2">{group('Frequent', frequent, moreFrequent, () => setMoreFrequent(!moreFrequent))}{group('Recent', recent, moreRecent, () => setMoreRecent(!moreRecent))}</div><p className="mt-3 text-[11px] text-muted-foreground">Projects may appear in both lists. Opening folders does not change these rankings.</p></>
          : <p className="py-6 text-xs leading-relaxed text-muted-foreground">No known projects on {instance.label} yet. Browse to the folder where you want to work.</p>}
        <Button variant="outline" className="mt-4 min-h-11 w-full justify-between border-dashed text-xs" onClick={() => setMode('browse')}>Browse folders on this host<ChevronRight className="size-4" /></Button>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span className="min-w-0 [overflow-wrap:anywhere]">{workspace ? `Workspace · ${workspace}` : 'No workspace chosen'}</span><Button size="sm" variant="ghost" onClick={() => { navigate(workspace ?? ''); setMode('workspace'); }}>Change workspace</Button></div>
      </> : <>
        <div className="flex flex-wrap gap-1"><Button variant="outline" size="sm" disabled={!parent || loading || creating} onClick={() => parent && navigate(parent)}><ArrowUp className="size-3.5" />Up one folder</Button>{workspace ? <Button variant="ghost" size="sm" disabled={creating} onClick={() => navigate(workspace)}>Workspace</Button> : null}</div>
        <nav aria-label="Folder breadcrumbs" className="my-2 flex flex-wrap items-center gap-0.5 text-xs">
          <Button size="sm" variant="ghost" disabled={creating} onClick={() => navigate(currentPath.match(/^[A-Za-z]:/)?.[0] ? `${currentPath.slice(0, 2)}/` : '/')} className="text-xs">Computer /</Button>
          {pathSegments(currentPath).filter((segment) => segment !== '/').map((segment, index) => {
            const destination = breadcrumbPath(currentPath, index);
            return <React.Fragment key={destination}><Button size="sm" variant="ghost" disabled={creating} className="h-auto min-h-9 max-w-full whitespace-normal text-left text-xs [overflow-wrap:anywhere]" aria-current={destination === currentPath ? 'location' : undefined} onClick={() => navigate(destination)}>{segment}</Button><span aria-hidden="true" className="text-muted-foreground">/</span></React.Fragment>;
          })}
        </nav>
        <h3 ref={folderTitle} tabIndex={-1} className="text-sm font-medium outline-none [overflow-wrap:anywhere]">{currentPath === '/' ? 'Computer · filesystem root' : directoryName(currentPath) || 'Folders'}</h3>
        <p className="mb-3 mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">{currentPath || `Workspace suggested by ${instance.label}`}</p>
        {loading ? <p role="status" className="flex items-center gap-2 py-5 text-xs text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading folders on {instance.label}…</p> : null}
        {failed ? <div role="alert" className="py-3 text-xs leading-relaxed"><p>{instance.label} could not open this folder. Try again below, enter another path, or use the breadcrumbs to go back. An older Kiln may need an update to browse this computer.</p><Button variant="link" size="sm" onClick={() => setRetry((n) => n + 1)}>Try again</Button></div> : null}
        {!loading && !failed && listing ? <div className="border-t">{listing.directories.map((entry) => row(entry.path, entry.name))}{!listing.directories.length ? <p className="py-5 text-xs text-muted-foreground">No subfolders here. Choose this folder, or go up to explore another.</p> : null}</div> : null}
        {!canBrowse ? <p className="py-4 text-xs leading-relaxed text-muted-foreground">{instance.label} does not offer folder browsing. Enter the full path below, then choose this folder.</p> : null}
        <div className="mt-2 flex flex-wrap gap-1"><Button ref={pathOpener} size="sm" variant="ghost" disabled={creating} onClick={() => { setTyped(currentPath); setForm('path'); setCreateFailed(false); }}>Enter a path…</Button>{canBrowse && listing && !loading && !failed ? <Button ref={newFolderOpener} size="sm" variant="ghost" disabled={creating} onClick={() => { setTyped(''); setForm('new'); setCreateFailed(false); }}>New folder…</Button> : null}</div>
        {form ? <form className="mt-2 rounded-md bg-muted/50 p-3" onSubmit={async (event) => {
          event.preventDefault();
          if (creating || !typed.trim()) return;
          if (form === 'path') { navigate(typed.trim()); return; }
          if (!validName || duplicateName) return;
          const token = ++request.current;
          setCreating(true); setCreateFailed(false);
          const created = await piCreateDirectory(instance.id, currentPath, typed.trim()).catch(() => null);
          if (!alive.current || request.current !== token) return;
          setCreating(false);
          if (created) navigate(created); else setCreateFailed(true);
        }}>
          <label className="mb-2 block text-xs" htmlFor={`folder-form-${instance.id}`}>{form === 'path' ? 'Existing folder path' : 'New folder name'}</label>
          <Input key={form} autoFocus id={`folder-form-${instance.id}`} value={typed} disabled={creating} onChange={(event) => setTyped(event.target.value)} className="min-h-11" />
          <p className="mt-2 text-[11px] text-muted-foreground">{form === 'path' ? 'Open a folder without selecting it.' : 'Create one child in this folder. Existing folders are never overwritten.'}</p>
          {form === 'new' && typed && (!validName || duplicateName) ? <p role="alert" className="mt-2 text-xs text-destructive">{duplicateName ? 'This folder already exists. Cancel and open it above, or use another name.' : 'Use one folder name without slashes. Choose the parent with the breadcrumbs.'}</p> : null}
          {createFailed ? <p role="alert" className="mt-2 text-xs text-destructive">{instance.label} could not create this folder. Try another name or check access to the parent, then try Create folder again.</p> : null}
          <div className="mt-3 flex gap-2"><Button size="sm" disabled={creating || !typed.trim() || (form === 'new' && (!validName || duplicateName))}>{creating ? 'Creating…' : form === 'path' ? 'Open path' : 'Create folder'}</Button><Button type="button" size="sm" variant="ghost" disabled={creating} onClick={cancelForm}>Cancel</Button></div>
        </form> : null}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <div className="min-w-0 flex-1 text-xs text-muted-foreground"><span>{mode === 'workspace' ? 'Use as your workspace' : 'Use this project folder'}</span><span className="mt-1 block [overflow-wrap:anywhere]">{currentPath}</span></div>
          <Button size="sm" className="min-h-11" disabled={creating || !!form || (canBrowse ? !listing || loading || failed : !currentPath.trim())} onClick={choose}><Check className="size-4" />{mode === 'workspace' ? 'Choose this workspace' : 'Choose this folder'}</Button>
        </div>
      </>}
    </div>
  </div>;
}
