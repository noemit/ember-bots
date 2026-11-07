import * as React from 'react';
import { ArrowLeft, Check, ChevronDown, ChevronRight, FolderOpen, Loader2 } from 'lucide-react';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
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
  return path.startsWith('/') ? `/${joined}` : joined;
};
export const directoryName = (path: string): string => pathSegments(path).at(-1) ?? path;

type Props = {
  instance: Instance;
  projects: Project[];
  recentDirectories?: string[];
  value: string;
  workspace?: string;
  onWorkspaceChange: (directory: string) => void;
  onSelect: (directory: string) => void;
  workspaceOnly?: boolean;
  disabled?: boolean;
};

/** One destination control. Workspace setup and deeper browsing are revealed only when needed. */
export default function ProjectPicker({ instance, projects, recentDirectories = [], value, workspace, onWorkspaceChange, onSelect, workspaceOnly = false, disabled = false }: Props) {
  const [open, setOpen] = React.useState(false);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><Button type="button" variant="ghost" size="sm" disabled={disabled}
      className="h-8 min-w-0 max-w-[300px] gap-2 px-2 text-xs font-normal"
      aria-label={workspaceOnly ? 'Choose workspace' : 'New agent project'} title={workspaceOnly ? workspace : value}
      >
      <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{workspaceOnly ? (workspace ? directoryName(workspace) : 'Choose workspace') : value ? directoryName(value) : 'Choose project'}</span>
      <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
    </Button></PopoverTrigger>
      <PopoverContent align="start" side="top" aria-label={workspaceOnly || !workspace ? 'Choose your workspace' : 'Choose a project'} className="flex max-h-[var(--radix-popover-content-available-height)] w-[min(400px,calc(100vw-2rem))] flex-col overflow-y-auto p-0">
        {open ? <PickerContent key={instance.id} instance={instance} projects={projects} recentDirectories={recentDirectories} value={value} workspace={workspace}
          workspaceOnly={workspaceOnly} onWorkspaceChange={onWorkspaceChange} onSelect={onSelect} onClose={() => setOpen(false)} /> : null}
      </PopoverContent>
  </Popover>;
}

function PickerContent({ instance, projects, recentDirectories = [], value, workspace, onWorkspaceChange, onSelect, workspaceOnly, onClose }: Props & { onClose: () => void }) {
  const [mode, setMode] = React.useState<'projects' | 'workspace' | 'browse'>(workspaceOnly || !workspace ? 'workspace' : 'projects');
  const [path, setPath] = React.useState(workspace ?? '');
  const [query, setQuery] = React.useState('');
  const [manual, setManual] = React.useState(false);
  const [typedPath, setTypedPath] = React.useState('');
  const [listing, setListing] = React.useState<{ path: string; directories: PiDirectory[] } | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [retry, setRetry] = React.useState(0);
  const [newFolder, setNewFolder] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [createFailed, setCreateFailed] = React.useState(false);
  const canBrowse = instance.kind === 'pi';
  const browsing = mode !== 'projects';

  React.useEffect(() => {
    if (!canBrowse) return;
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    setListing(null);
    void piLoadDirectories(instance.id, path || undefined, 'computer').catch(() => null).then((result) => {
      if (cancelled) return;
      setLoading(false);
      setFailed(!result);
      setListing(result);
    });
    return () => { cancelled = true; };
  }, [instance.id, canBrowse, path, retry]);

  const navigate = (next: string) => { if (next !== path) { setListing(null); setLoading(canBrowse); } setNewFolder(null); setCreateFailed(false); setPath(next); setQuery(''); setManual(false); };
  const choose = (directory: string) => { onSelect(directory); onClose(); };
  const confirmWorkspace = (directory: string) => {
    onWorkspaceChange(directory);
    if (workspaceOnly) { onClose(); return; }
    navigate(directory);
    setMode('projects');
  };
  const currentPath = listing?.path ?? path;
  const rows = browsing ? listing?.directories ?? [] : [
    ...(listing?.directories ?? []),
    ...(!canBrowse ? projects.filter((project) => project.path).map((project) => ({ name: project.name, path: project.path! })) : []),
  ].filter((row, index, all) => all.findIndex((other) => other.path === row.path) === index);
  const recents = [...new Set([value, ...recentDirectories].filter((directory) => directory && directory !== workspace))].slice(0, 6);
  const parent = parentPath(currentPath);
  const rowClass = 'cursor-pointer gap-3 rounded-md px-3 py-2.5 text-sm';

  return <>
    <div className="border-b px-4 py-3">
      <h2 className="text-sm font-medium">{mode === 'workspace' ? 'Choose your workspace' : browsing ? 'Choose a folder' : 'Choose a project'}</h2>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        {mode === 'workspace' ? `Pick the folder on ${instance.label} where your projects or work already live.` : `Work on ${instance.label}`}
      </p>
    </div>
    <Command>
      <CommandInput value={query} onValueChange={setQuery} placeholder={browsing ? 'Search folders…' : 'Search projects…'} aria-label="Filter projects" />
      {browsing ? <div className="flex items-center gap-2 border-b px-3 py-2">
        <Button variant="ghost" size="icon-sm" aria-label="Up one level" disabled={!parent || loading || creating} onClick={() => parent && navigate(parent)}><ArrowLeft className="size-4" /></Button>
        <span className="min-w-0 truncate text-xs text-muted-foreground" title={currentPath}>{currentPath || 'Loading workspace…'}</span>
      </div> : null}
      <CommandList className="max-h-[300px] p-1.5">
        {loading ? <div role="status" className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading folders on {instance.label}…</div> : null}
        {failed ? <div role="alert" className="px-3 py-3 text-xs">
          <p>{instance.label} could not open this folder. Check the path or choose another folder. Older Kilns may need an update to browse outside their workspace.</p>
          <Button variant="link" size="sm" onClick={() => setRetry((n) => n + 1)}>Try again</Button>
        </div> : null}
        {!browsing && recents.length > 0 ? <CommandGroup heading="Recent">
          {recents.map((directory) => <CommandItem key={directory} value={`recent ${directory}`} className={rowClass} onSelect={() => choose(directory)}>
            <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1"><span className="block truncate">{directoryName(directory)}</span><span className="block truncate text-xs text-muted-foreground">{directory}</span></span>
            {directory === value ? <Check className="size-4 text-highlight" /> : null}
          </CommandItem>)}
        </CommandGroup> : null}
        <CommandGroup heading={browsing ? undefined : 'In your workspace'}>
          {rows.filter((row) => browsing || !recents.includes(row.path)).map((row) => <CommandItem key={row.path} disabled={creating} value={`${row.name} ${row.path}`} className={rowClass}
            onSelect={() => browsing ? navigate(row.path) : choose(row.path)}>
            <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1"><span className="block truncate">{row.name}</span>
              {!browsing ? <span className="block truncate text-xs text-muted-foreground">{row.path}</span> : null}</span>
            {!browsing && row.path === value ? <Check className="size-4 text-highlight" /> : null}
            {browsing ? <ChevronRight className="size-4 text-muted-foreground" /> : null}
          </CommandItem>)}
        </CommandGroup>
        {!loading && !failed ? <CommandEmpty className="px-3 py-5 text-center text-xs text-muted-foreground">
          {query ? 'No matching folders. Try another name or browse below.' : browsing ? 'No subfolders here. You can use this folder.' : 'No projects here yet. Use the workspace or choose another folder below.'}
        </CommandEmpty> : null}
      </CommandList>
    </Command>
    <div className="flex flex-col gap-1 border-t p-2">
      {browsing ? <>
        <Button className="justify-start" size="sm" disabled={creating || (canBrowse ? !listing || loading || failed : !currentPath.trim())}
          onClick={() => mode === 'workspace' ? confirmWorkspace(currentPath) : choose(currentPath)}>
          <Check className="size-4" />{mode === 'workspace' ? 'Use this workspace' : 'Use this folder'}
        </Button>
        {workspace && !workspaceOnly ? <Button variant="ghost" size="sm" className="justify-start" onClick={() => { navigate(workspace); setMode('projects'); }}>Back to projects</Button> : null}
      </> : <>
        {workspace ? <Button variant="ghost" size="sm" className="justify-start" onClick={() => choose(workspace)}><FolderOpen className="size-4" />Work in {directoryName(workspace)}</Button> : null}
        <Button variant="ghost" size="sm" className="justify-start" onClick={() => { navigate(workspace ?? ''); setMode('browse'); }}><FolderOpen className="size-4" />Choose another folder…</Button>
        <div className="flex items-center justify-between gap-2 px-3 py-1 text-xs text-muted-foreground">
          <span className="truncate" title={workspace}>Workspace · {directoryName(workspace ?? '')}</span>
          <button className="shrink-0 underline-offset-2 hover:underline" onClick={() => { navigate(workspace ?? ''); setMode('workspace'); }}>Change workspace</button>
        </div>
      </>}
      {browsing && canBrowse && listing && !loading && !failed ? <>
        {newFolder === null ? <Button size="sm" variant="ghost" className="justify-start" onClick={() => { setNewFolder(''); setCreateFailed(false); }}>New folder…</Button> :
          <form className="flex flex-col gap-2 p-1" onSubmit={async (event) => {
            event.preventDefault();
            if (creating || !newFolder.trim()) return;
            setCreating(true); setCreateFailed(false);
            const created = await piCreateDirectory(instance.id, currentPath, newFolder.trim()).catch(() => null);
            setCreating(false);
            if (created) navigate(created);
            else setCreateFailed(true);
          }}>
            <Input autoFocus aria-label="New folder name" placeholder="Folder name" value={newFolder} disabled={creating} onChange={(event) => setNewFolder(event.target.value)} />
            {createFailed ? <p role="alert" className="text-xs text-destructive">{instance.label} could not create this folder. Try another name or check access to the parent folder.</p> : null}
            <div className="flex gap-2"><Button size="sm" disabled={creating || !newFolder.trim()}>{creating ? 'Creating…' : 'Create folder'}</Button>
              <Button type="button" size="sm" variant="ghost" disabled={creating} onClick={() => { setNewFolder(null); setCreateFailed(false); }}>Cancel</Button></div>
          </form>}
      </> : null}
      {browsing ? <>
        {manual || !canBrowse ? <form className="flex gap-2 p-1" onSubmit={(event) => {
          event.preventDefault();
          if (!typedPath.trim()) return;
          if (canBrowse) navigate(typedPath.trim());
          else if (mode === 'workspace') confirmWorkspace(typedPath.trim());
          else choose(typedPath.trim());
        }}>
          <Input autoFocus aria-label="Folder path" placeholder="Full folder path" value={typedPath} onChange={(event) => setTypedPath(event.target.value)} className="h-8 text-xs" />
          <Button size="sm" variant="secondary" disabled={!typedPath.trim()}>{canBrowse ? 'Open' : 'Use folder'}</Button>
        </form> : <Button variant="ghost" size="sm" className="justify-start text-muted-foreground" onClick={() => { setTypedPath(currentPath); setManual(true); }}>Enter a folder path…</Button>}
      </> : null}
    </div>
  </>;
}
