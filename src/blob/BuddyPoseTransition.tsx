import * as React from 'react';
import type { BallMood } from '../types';

type Props = { mood: BallMood; root: React.RefObject<HTMLDivElement | null>; children: React.ReactNode };
type Pose = Map<Element, string>;
const LAYERS = '.blob-hop, .blob-flip, .blob-eyes, .buddy-gaze';
const SETTLE_MS = 280;

/**
 * CSS switches animation names immediately, including their seeded negative delays. Capture the
 * outgoing pose BEFORE React changes data-mood, then bridge to the new, still-running animation.
 * getSnapshotBeforeUpdate is intentional: a layout-effect cleanup can see the already-mutated DOM.
 * Only transforms are animated; there is one body and one badge, never a crossfaded duplicate.
 */
export default class BuddyPoseTransition extends React.Component<Props, Record<string, never>, Pose | null> {
  private bridges = new Set<Animation>();
  private reduced: MediaQueryList | null = null;
  private gazeObserver: MutationObserver | null = null;

  componentDidMount() {
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.reduced.addEventListener('change', this.onMotionPreference);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  componentWillUnmount() {
    this.cancelBridges();
    this.reduced?.removeEventListener('change', this.onMotionPreference);
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  private cancelBridges = () => {
    this.bridges.forEach(animation => animation.cancel());
    this.bridges.clear();
    this.gazeObserver?.disconnect();
    this.gazeObserver = null;
  };

  private onMotionPreference = () => {
    if (this.reduced?.matches) this.cancelBridges();
  };

  private onVisibility = () => {
    this.bridges.forEach(animation => document.hidden ? animation.pause() : animation.play());
  };

  getSnapshotBeforeUpdate(previous: Props): Pose | null {
    if (previous.mood === this.props.mood || this.props.mood === 'unknown' || this.reduced?.matches || document.hidden) return null;
    const layers = this.props.root.current?.querySelectorAll(LAYERS);
    return layers ? new Map([...layers].map(layer => [layer, getComputedStyle(layer).transform])) : null;
  }

  componentDidUpdate(previous: Props, _state: Record<string, never>, poses: Pose | null) {
    if (previous.mood === this.props.mood) return;
    // A rapid second mood change starts from the visible blended pose, not the first bridge's end.
    this.cancelBridges();
    if (!poses) return;
    // Batch reads before writes. No measurement or JS loop runs on ordinary animation frames.
    const corrections = [...poses].filter(([layer]) => layer.isConnected).map(([layer, before]) => {
      const current = getComputedStyle(layer).transform;
      const oldMatrix = new DOMMatrix(before === 'none' ? undefined : before);
      const newMatrix = new DOMMatrix(current === 'none' ? undefined : current);
      return { layer, correction: newMatrix.inverse().multiply(oldMatrix) };
    });
    for (const { layer, correction } of corrections) {
      if (correction.isIdentity) continue;
      // Add AFTER the live CSS transform: newPose × inverse(newPose) × oldPose = oldPose.
      // As the correction reaches identity, the destination's normal motion takes over naturally.
      const animation = layer.animate([
        { transform: correction.toString() },
        { transform: 'matrix(1, 0, 0, 1, 0, 0)' },
      ], { duration: SETTLE_MS, easing: 'cubic-bezier(.2, .7, .3, 1)', composite: 'add' });
      this.bridges.add(animation);
      const release = () => {
        this.bridges.delete(animation);
        if (!this.bridges.size) { this.gazeObserver?.disconnect(); this.gazeObserver = null; }
      };
      void animation.finished.then(release, release);
    }
    const root = this.props.root.current;
    if (root && this.bridges.size) {
      // A pointer arriving during the short handoff owns gaze immediately. Never leave an
      // autonomous correction added on top of direct input. Observe only while a bridge exists.
      this.gazeObserver = new MutationObserver(() => {
        if (!root.hasAttribute('data-pupil-tracking')) return;
        this.bridges.forEach(animation => {
          const target = (animation.effect as KeyframeEffect | null)?.target;
          if (target?.classList.contains('buddy-gaze')) animation.cancel();
        });
      });
      this.gazeObserver.observe(root, { attributes: true, attributeFilter: ['data-pupil-tracking'] });
    }
  }

  render() { return this.props.children; }
}
