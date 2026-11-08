/** UI wording only: the host's archive contract remains unchanged. */
export const sessionVisibilityFailure = (host: string | undefined, hidden: boolean): string =>
  `${host?.trim() || 'The session’s host'} did not confirm that it could ${hidden ? 'hide' : 'unhide'} this session. Use Retry to try again.`;
