export const titleSaveFailure = (host: string): string =>
  host + " did not save this chat's name. Rename it again from the chat title.";

/** Serial writes preserve human ordering; only confirmed titles are rollback baselines. */
export class SessionTitleWrites {
  private pending = new Map<string, { tail: Promise<void>; revision: number; confirmed: string | undefined }>();

  async rename(key: string, previous: string | undefined, next: string, actions: {
    apply: (title: string | undefined) => void;
    write: () => Promise<boolean>;
    failed: () => void;
  }): Promise<void> {
    const state = this.pending.get(key) ?? { tail: Promise.resolve(), revision: 0, confirmed: previous };
    const revision = ++state.revision;
    actions.apply(next);
    const write = state.tail.then(async () => {
      try {
        if (!(await actions.write())) throw new Error('Title was not saved');
        state.confirmed = next;
      } catch {
        if (state.revision !== revision) return;
        actions.apply(state.confirmed);
        actions.failed();
      }
    });
    state.tail = write;
    this.pending.set(key, state);
    await write;
    if (state.tail === write) this.pending.delete(key);
  }
}
