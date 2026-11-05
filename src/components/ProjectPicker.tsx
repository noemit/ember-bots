import * as React from 'react';
import { Check, ChevronRight, CornerLeftUp, FolderOpen, Loader2 } from 'lucide-react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { Project } from '../types';

/** A folder the picker can descend into. `hasChildren: false` hides the chevron. */
export type BrowseDirectory = { name: string; path: string; hasChildren?: boolean };

type Props = {
  projects: Project[];
  /** Current folder; matches a project by path, otherwise shows as a custom folder. */
  value: string;
  onSelect: (directory: string) => void;
  /**
   * Lists the subfolders of `path`, for descending past the workspace root's own children. Without
   * it the picker stays a flat list of `projects` — the host cannot be asked for anything deeper.
   * `null` means the request failed, which the picker shows as an error rather than an empty folder.
   */
  onBrowse?: (path: string) => Promise<BrowseDirectory[] | null>;
  /** A new agent's session is already being created, so its destination can no longer change. */
  disabled?: boolean;
};

/** `/home/em/workspace/ember` → `['/', 'home', 'em', 'workspace', 'ember']`. A bare drive survives. */
export const pathSegments = (path: string): string[] =>
  path.split(/[\\/]/).reduce<string[]>((segments, part, index) => {
    if (index === 0 && part === '') return ['/'];
    if (part) segments.push(part);
    return segments;
  }, []);

export const parentPath = (path: string): string | null => {
  const segments = pathSegments(path);
  // `['/', 'home']` is the top of what the browser can show: there is nowhere further up to go.
  if (segments.length <= 2) return null;
  // Segments after a leading '/' join without one, or every parent would start with '//'.
  const [head, ...rest] = segments;
  const parent = rest.slice(0, -1).join('/');
  return head === '/' ? `/${parent}` : parent;
};

/** Every ancestor of `path`, outermost first, each with the path to navigate to. */
export const breadcrumbPath = (path: string, upTo: number): string => {
  const named = pathSegments(path).filter((segment) => segment !== '/');
  const joined = named.slice(0, upTo + 1).join('/');
  return path.startsWith('/') ? `/${joined}` : joined;
};

export const directoryName = (path: string): string => {
  const segments = pathSegments(path);
  return segments[segments.length - 1] ?? path;
};

export default function ProjectPicker({ projects, value, onSelect, onBrowse, disabled = false }: Props) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  /** The folder being browsed; empty means "the workspace root", i.e. the configured projects. */
  const [browsing, setBrowsing] = React.useState('');
  const [children, setChildren] = React.useState<BrowseDirectory[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const requestRef = React.useRef(0);

  const selectableProjects = React.useMemo(
    () => projects.filter((project): project is Project & { path: string } => Boolean(project.path)),
    [projects]
  );
  const selected = selectableProjects.find((project) => project.path === value) ?? null;

  React.useEffect(() => {
    if (open) {
      setQuery('');
      setBrowsing('');
      setChildren(null);
      setFailed(false);
    }
  }, [open]);

  // Descending is a fresh request; a stale answer (a fast second click) must not replace the current folder.
  React.useEffect(() => {
    if (!open || !browsing || !onBrowse) return;
    const ticket = ++requestRef.current;
    setLoading(true);
    setFailed(false);
    setChildren(null);
    void onBrowse(browsing).then((result) => {
      if (requestRef.current !== ticket) return;
      setLoading(false);
      if (result === null) {
        setFailed(true);
        setChildren([]);
        return;
      }
      // A folder with nothing in it would strand the user on an empty screen: back out instead.
      if (result.length === 0) {
        setBrowsing('');
        return;
      }
      setChildren(result);
    });
    return () => {
      requestRef.current += 1;
    };
  }, [open, browsing, onBrowse]);

  const select = (directory: string) => {
    onSelect(directory);
    setOpen(false);
  };

  const descend = (directory: BrowseDirectory) => {
    setQuery('');
    setBrowsing(directory.path);
  };

  const atRoot = !browsing;
  const parent = browsing ? parentPath(browsing) : null;
  const rows: BrowseDirectory[] = atRoot
    ? selectableProjects.map((project) => ({ name: project.name, path: project.path }))
    : children ?? [];

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 max-w-[220px] px-2 text-xs font-normal"
        onClick={() => setOpen(true)}
        disabled={disabled}
        aria-label="New agent project"
      >
        <FolderOpen className="size-3.5 text-muted-foreground" />
        <span className="truncate">{selected?.name ?? 'Custom folder'}</span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[calc(100vw-1rem)] max-w-[460px] gap-0 overflow-hidden p-0" showCloseButton={false}>
          <DialogTitle className="sr-only">Choose a project</DialogTitle>
          <Command>
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder={atRoot ? 'Type a project name or folder…' : `Filter in ${directoryName(browsing) || browsing}…`}
              aria-label="Filter projects"
              className="h-10 text-xs"
            />
            {!atRoot ? (
              <div className="flex items-center gap-1.5 px-2.5 pb-1.5 pt-0.5 text-[11px] text-muted-foreground">
                <button
                  type="button"
                  onClick={() => {
                    setQuery('');
                    setBrowsing('');
                  }}
                  className="truncate underline-offset-2 hover:text-foreground hover:underline"
                  title="Back to the workspace root"
                >
                  Projects
                </button>
                {pathSegments(browsing).filter((segment) => segment !== '/').map((segment, index, all) => {
                  const target = breadcrumbPath(browsing, index);
                  return (
                    <React.Fragment key={target}>
                      <ChevronRight className="size-3 flex-none opacity-60" aria-hidden="true" />
                      {index === all.length - 1 ? (
                        <span className="truncate font-medium text-foreground">{segment}</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setQuery('');
                            setBrowsing(target);
                          }}
                          className="truncate underline-offset-2 hover:text-foreground hover:underline"
                        >
                          {segment}
                        </button>
                      )}
                    </React.Fragment>
                  );
                })}
              </div>
            ) : null}
            <CommandList className="max-h-[320px] overflow-y-auto p-1.5">
              <CommandGroup>
                {atRoot ? (
                  <CommandItem
                    value=""
                    onSelect={() => select('')}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-left text-[12.5px] aria-selected:bg-muted"
                  >
                    <span className="flex-1">Custom folder</span>
                    {!selected ? <Check className="size-3.5 text-highlight" /> : null}
                  </CommandItem>
                ) : parent !== null ? (
                  <CommandItem
                    value="__up__"
                    onSelect={() => {
                      setQuery('');
                      setBrowsing(parent === '' ? '' : parent);
                    }}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-left text-[12.5px] aria-selected:bg-muted"
                  >
                    <CornerLeftUp className="size-3.5 text-muted-foreground" />
                    <span className="flex-1">Up one level</span>
                  </CommandItem>
                ) : null}
                {browsing ? (
                  <CommandItem
                    key={`__here__${browsing}`}
                    value={`__here__${browsing} ${browsing}`}
                    onSelect={() => select(browsing)}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-left text-[12.5px] aria-selected:bg-muted"
                  >
                    <FolderOpen className="size-3.5 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">Use “{directoryName(browsing) || browsing}”</span>
                      <span className="block truncate text-[11px] text-muted-foreground">{browsing}</span>
                    </span>
                    {browsing === value ? <Check className="mt-0.5 size-3.5 text-highlight" /> : null}
                  </CommandItem>
                ) : null}
                {loading ? (
                  <div
                    className="flex items-center gap-2 px-2.5 py-3 text-[11.5px] text-muted-foreground"
                    role="status"
                  >
                    <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                    Loading folders…
                  </div>
                ) : null}
                {failed ? (
                  <div className="px-2.5 py-3 text-[11.5px] text-destructive" role="alert">
                    Could not read this folder.
                  </div>
                ) : null}
                {rows.map((row) => {
                  const canDescend = Boolean(onBrowse) && row.hasChildren !== false;
                  return (
                    <CommandItem
                      key={row.path}
                      value={`${row.name}\n${row.path}`}
                      onSelect={() => select(row.path)}
                      className="flex cursor-pointer items-start gap-2 rounded-md py-2 pl-2.5 pr-1 text-left text-[12.5px] aria-selected:bg-muted"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{row.name}</span>
                        <span className="block truncate text-[11px] text-muted-foreground">{row.path}</span>
                      </span>
                      {row.path === value ? <Check className="mt-0.5 size-3.5 text-highlight" /> : null}
                      {canDescend ? (
                        <button
                          type="button"
                          aria-label={`Open ${row.name}`}
                          title={`Open ${row.name}`}
                          onClick={(event) => {
                            // The row's own onSelect must not fire: descending is not choosing.
                            event.preventDefault();
                            event.stopPropagation();
                            descend(row);
                          }}
                          className="-mr-0.5 flex size-6 flex-none items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                        >
                          <ChevronRight className="size-3.5" />
                        </button>
                      ) : null}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
              <CommandEmpty className="px-3 py-8 text-center text-xs text-muted-foreground">
                {atRoot ? `No projects match “${query.trim()}”.` : 'No folders match.'}
              </CommandEmpty>
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  );
}
