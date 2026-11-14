/** Folder names are navigation, not previews: never shorten or clamp them. */
export default function RailFolder({ name, path }: { name?: string; path?: string }) {
  const label = name || path?.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  return label ? <span data-rail-folder="" title={path} aria-label={path ? label + ' — ' + path : label}
    className="block min-w-0 whitespace-normal text-[11px] leading-4 font-medium text-muted-foreground [overflow-wrap:anywhere]">{label}</span> : null;
}
