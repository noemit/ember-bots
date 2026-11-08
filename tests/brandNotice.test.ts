import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const license = readFileSync(new URL('../LICENSE', import.meta.url), 'utf8');
const brand = readme.split('## Brand and visual assets\n')[1] ?? '';

describe('brand notice documentation', () => {
  test('permission contact and official website have consistent usable links', () => {
    expect(brand).toContain('[em-bot@mail.grokbot.com](mailto:em-bot@mail.grokbot.com)');
    expect(brand).toContain('[getemberbots.com](https://getemberbots.com)');
    expect(readme).toContain('(LICENSE)');
    const heading = 'Brand and visual assets'.toLowerCase().replaceAll(' ', '-');
    expect(readme).toContain(`(#${heading})`);
    expect(license).toContain(`README.md#${heading}`);
  });

  test('the reservation distinguishes Ember artwork from MIT renderer source and third-party rights', () => {
    expect(brand).toMatch(/Ember name, logos, bot character artwork/);
    expect(brand).toMatch(/excluded[\s\S]*MIT licence unless explicitly stated otherwise/);
    expect(brand).toMatch(/generated character artwork, not the software\s+source code/);
    expect(readme).toMatch(/including the renderer source, remains MIT-licensed/);
    for (const notice of [brand, license]) {
      expect(notice).toMatch(/No trademark\s+rights are granted/i);
      expect(notice).toMatch(/does not revoke permissions already granted/);
      expect(notice).toMatch(/Third-party names, marks and assets remain subject/i);
    }
  });

  test('the MIT permission grant and warranty disclaimer remain present', () => {
    const mit = license.slice(license.indexOf('MIT License\n'));
    expect(mit).toStartWith('MIT License\n\nCopyright (c) 2026 Noemi Titarenco\n');
    expect(mit).toContain('Permission is hereby granted, free of charge');
    expect(mit).toContain('use, copy, modify, merge, publish, distribute, sublicense, and/or sell');
    expect(mit).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
  });
});
