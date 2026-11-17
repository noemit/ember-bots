import { describe, expect, test } from 'bun:test';
import { SETTINGS_SECTIONS, settingsSection } from '../src/lib/settingsNavigation';
describe('Settings destinations', () => {
  test('keeps old navigation entrypoints useful without a General junk drawer', () => {
    expect(settingsSection('general')).toBe('appearance');
    expect(settingsSection('instances')).toBe('computers');
    expect(settingsSection('unknown')).toBe('providers');
  });
  test('has exactly five real destinations, including computers and containers', () => {
    expect(SETTINGS_SECTIONS).toHaveLength(5);
    expect(SETTINGS_SECTIONS.find(section => section.id === 'computers')?.label).toBe('Computers and Containers');
    for (const section of SETTINGS_SECTIONS) expect(settingsSection(section.id)).toBe(section.id);
  });
});
