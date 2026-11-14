/** Dev-only browser fixture: no bridge, backend, credentials or conversation writes. */
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import CrewStrip from '../../src/components/CrewStrip';
import type { BallState, Session, WorkerTask } from '../../src/types';
import '../../src/styles.css';

const statuses: WorkerTask['status'][] = ['working', 'waiting', 'blocked', 'failed', 'stopped', 'done', 'working', 'waiting'];
const titles = ['Review provider connection recovery', 'Check keyboard navigation and focus', 'Gather browser evidence for release', 'Repair unavailable model selection', 'Inspect paused migration safely', 'Capture narrow pane screenshots', 'Validate pending approval controls', 'Keep assigned work open while idle', 'Legacy parent with a waiting helper', 'Legacy nested question still reachable', 'Legacy idle is not completed', 'Another legacy idle chat is not completed'];
const stress = new URLSearchParams(location.search).has('stress');
const longToken = 'SyntheticUnbrokenTaskEvidence'.repeat(16);
const workers: Session[] = titles.map((title, i) => ({
  id: String(i), instanceId: 'synthetic', kind: 'worker', title,
  ...(i < 8 ? { task: { id: 'task-' + i, title, status: statuses[i], ...(i === 5 ? { completion: { task: 'task-5', summary: 'Screenshots captured', evidence: 'Synthetic fixture only', remaining: 'Device checks', requestId: 'receipt', at: 1 } } : {}) } } : {}),
  ...(i === 6 || i === 9 ? { needsInput: true } : {}),
}));
if (stress) {
  for (const index of [0, 5]) {
    workers[index].title = longToken;
    workers[index].task!.title = longToken;
  }
  workers[5].task!.completion = { ...workers[5].task!.completion!, summary: longToken, evidence: longToken, remaining: longToken };
}
const rows = workers.map((worker, i) => ({ worker, depth: i === 9 ? 3 : 1, group: i === 9 ? workers[8] : worker }));
function Fixture() {
  const [opened, setOpened] = React.useState('None');
  const [auto, setAuto] = React.useState<Record<string, boolean>>({ 'synthetic::0': true });
  const stateFor = (worker: Session): BallState => worker.needsInput ? 'needs-input' : worker.id === '8' ? 'unknown' : worker.id === '0' ? 'active' : worker.id === '3' ? 'error' : 'idle';
  return <div style={{ padding: 16 }}>
    <h1>Synthetic Tasks · 12 assignments and legacy chats</h1>
    <p>No host connection. Opened: <output>{opened}</output></p>
    <section id="fixture-pane" style={{ width: 1040, marginTop: 20 }}>
      <CrewStrip rows={rows} blobStyle="buddy" leaderTitle="Grid review" stateFor={stateFor}
        autoAcceptByKey={auto} onToggleYolo={(worker, enabled) => setAuto((old) => ({ ...old, ['synthetic::' + worker.id]: enabled }))}
        onOpenWorker={(worker) => setOpened(worker.title ?? worker.id)} />
    </section>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
