import { mergeAvatarAssignments, parseAvatarAssignments } from '../../electron/transport';
import type { AvatarAssignment } from '../types';

type Assignments = Record<string, AvatarAssignment>;

/** Keep unsaved identities until main acknowledges them, independently of settings revisions. */
export class AvatarAssignmentWrites {
  private confirmed: Assignments = {};
  private pending: Assignments = {};

  stage(incoming: unknown): void {
    this.pending = mergeAvatarAssignments(this.pending, incoming);
    for (const key of Object.keys(this.confirmed)) delete this.pending[key];
  }

  /** Responses can acknowledge another client's winning identity, including after a lost reply. */
  acknowledge(stored: unknown): void {
    const accepted = parseAvatarAssignments(stored);
    this.confirmed = mergeAvatarAssignments(this.confirmed, accepted);
    for (const key of Object.keys(accepted)) delete this.pending[key];
  }

  additions(): Assignments {
    return { ...this.pending };
  }

  visible(): Assignments {
    return { ...this.pending, ...this.confirmed };
  }
}
