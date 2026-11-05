/**
 * A create that produced no session, and the status that says which side failed.
 *
 * The caller cannot phrase this without the status: a 4xx is the host refusing with its own reason
 * (`folder does not exist: …`), a 5xx is the host failing on its side, and 0 is the transport — Ember
 * never got an answer, so for a POST the conversation may well exist anyway. `message` carries the
 * host's words (empty when it gave none); it is never a sentence Ember invented, because the UI
 * writes its own around it (see `lib/newSessionFailure.ts`).
 *
 * It lives here rather than in `api.ts` because both wire layers throw it (`createSession` for
 * OpenChamber, `piCreateSession` for Hearth), and importing it back out of `api.ts` would make the
 * api/piApi pair import each other at runtime for a class.
 */
export class SessionCreateError extends Error {
  readonly status: number;

  constructor(status: number, detail?: string) {
    super(detail?.trim() ?? '');
    this.name = 'SessionCreateError';
    this.status = status;
  }
}
