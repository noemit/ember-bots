/** Canonical destinations. Legacy entrypoints remain readable at the boundary. */
export const SETTINGS_SECTIONS = [
  { id: 'providers', label: 'Providers', description: 'Connect and manage model providers on each computer or container.' },
  { id: 'computers', label: 'Computers and Containers', description: 'Connect a Kiln on a computer or container, and set defaults for new chats.' },
  { id: 'appearance', label: 'Appearance', description: 'Adjust colors, text sizes and chat avatars.' },
  { id: 'conversations', label: 'Conversations', description: 'Choose which chats stay in the sidebar and how unread replies work.' },
  { id: 'remote', label: 'Remote access', description: 'Open this Ember in a browser, or let another Ember connect to this Kiln.' },
] as const;
export type SettingsSection = typeof SETTINGS_SECTIONS[number]['id'];
export type SettingsView = SettingsSection | 'general' | 'instances';
export function settingsSection(view: string): SettingsSection {
  if (view === 'general') return 'appearance';
  if (view === 'instances') return 'computers';
  return SETTINGS_SECTIONS.find(section => section.id === view)?.id ?? 'providers';
}
