import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import OnboardingPrivacy from '../src/components/OnboardingPrivacy';
import { stepsFor, stepStates } from '../src/lib/onboarding';

const state = { localReady: true, canRotate: true, remoteReady: false, targetInstanceId: 'local' };

test('privacy and support conclude setup without changing its earlier steps', () => {
  const steps = stepsFor(state);
  expect(steps.at(-1)?.id).toBe('privacy');
  expect(steps.at(-2)?.id).toBe('first-agent');
  expect(stepStates(state).privacy.kind).toBe('pending');
});

test('privacy promise names the recipient and distinguishes provider and network traffic', () => {
  const html = renderToStaticMarkup(<OnboardingPrivacy />);
  expect(html).toContain('Ember doesn’t send us analytics, crash reports, or bug reports');
  expect(html).toContain('unless you tell us');
  expect(html).toContain('Your chosen AI provider receives the messages');
  expect(html).toContain('updates and model catalogues');
  expect(html).not.toMatch(/never sends data|no network|never collects/i);
  expect(html).toContain('href="https://x.com/noemititarenco"');
  expect(html).toContain('href="mailto:em-bot@mail.grokbot.com"');
  expect(html).toContain('Built by ');
  expect(html).toContain('Found an issue? ');
});
