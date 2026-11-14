# Host permission rules v1

Authenticated routes (same bearer auth as approvals):

- `POST /approvals/:cid/:key/preview` body `{command?: string}` returns `PermissionPreview` below. Unsupported is HTTP 200 with `supported:false` and a human-readable reason. The optional command is the exact future command to remember; omission means the pending original. `policy` describes that future command, not the original. Both commands must independently pass the same restricted recognizer; edits never change what executes for the pending request.
- Existing `POST /approvals/:cid/:key/reply` additionally accepts `{decision:'similar',command?:string}`. Success `{ok:true}`; unsupported/changed preview HTTP 400. Atomic rule save plus approval resolution. Repeating the identical similar reply succeeds without recreating a deleted rule. Idempotence compares the recorded future command: retries of edited rules must resend that edited command; omitting it means the original and is not an identical retry. Other decisions unchanged.
- `GET /conversations/:id/permission-rules` returns `{rules: PermissionRule[]}`.
- `DELETE /conversations/:id/permission-rules/:ruleId` and `DELETE /conversations/:id/permission-rules` return `{ok:true}` (idempotent).

```ts
type PermissionPolicy = {
  kind: 'exact-argv-v1'; maxTimeoutSeconds: 30; argv: string[]; cwd: string;
  executable: string; environment: 'clean-v1';
};
type PermissionPreview = {
  supported: boolean; reason: string; policy?: PermissionPolicy;
};
type PermissionRule = PermissionPolicy & {
  id: string; conversationId: string; createdAt: number;
};
```

Only Linux local Node execution environments explicitly attested by host construction are supported initially. Hosts with a configured managed scope-shell wrapper fail closed with an explanatory unsupported preview; direct argv scope accounting is not implemented. Unknown/custom execution environments also fail closed. Exact bare-token commands `pwd`, `ls`, and `wc`, with constrained arguments, are supported; no shell parsing or shell execution occurs for similar-approved originals or remembered calls. Whitespace is single ASCII spaces; argument characters are restricted ASCII. No prefixes, globs, operators, quotes, substitutions, wrappers, environment assignments, interpreters, Git or build/test runners. `bun test` executes arbitrary project code and is unsupported, not labelled safe.

Rules apply only to the originating conversation and canonical cwd identity, never projects/forks/workers. Executable real path, root-owned non-writable ancestry, and file identity/digest are checked. Execution uses direct argv and a clean fixed environment, with conversation attribution and temporary-folder variables produced by `sessionEnv` added. The canonical host home is part of the internal binding, so changing that environment root invalidates reuse. Rule revocation affects future calls immediately, not commands already admitted/running. Calls emit an origin-rule diagnostic. This is permission reuse, not a filesystem sandbox or a claim of semantic safety.

## Enforcement audit and limitations

`Approvals` wraps by name after `CodingTools` and after codemode installation (`registry.ts`). The codemode QuickJS sandbox has no shell/host execution API; nested tool invocations use pi-durable `executeTool`, resolving the composed wrapped registrations. A rule is considered only inside the real `bash` gate, never for the outer codemode script. Non-bash tools still need their existing approval. Tests exercise both an allowed nested `pwd` and a rejected nested `bun test`.

`permissionRules.ts` recognizes only exact tokens with no shell parser, evaluation, subprocess, or command execution during matching/preview. Root-owned non-group/world-writable system ELF binaries and their ancestor directories are required; real path, inode, timestamps, size and SHA-256 are rebound on every call. Administrator/root compromise and mutable system shared libraries are outside this permission-reuse threat model. Root-level system updates intentionally invalidate old rules. A cwd directory fd is held across execution and addressed through the host's procfs fd path; pathname replacement cannot redirect execution after admission. Procfs availability is checked before offering the rule.

Remembered calls run direct argv in a fresh trusted `NodeExecutionEnv`, not the conversation's shell/custom execution implementation. Environment inheritance is disabled; the environment contains only `PATH=/usr/bin:/bin`, `LANG=C`, `LC_ALL=C`, and `sessionEnv`'s `HEARTH_CONVERSATION`, `TMPDIR`, `TMP`, and `TEMP` for this host home/conversation. Execution fails closed if the managed temporary folder cannot be prepared. `maxTimeoutSeconds` is 30. `index.ts` attests both the Harness and each Node environment with its home/accounting requirement. A configured scope wrapper disables permission reuse, including old saved grants and resumed originals; it is never silently bypassed. Output retention/spill and cancellation still use NodeExecutionEnv. Ordinary Allow, Deny and YOLO retain their prior execution behavior and take precedence over remembered matches.

Rules do not constrain file operands to the cwd. For example, an explicitly approved `ls ../other` retains that exact operand; `ls` output/file contents may change later. This is not a read sandbox and is not a guarantee that future data is harmless. No Git read-only grouping exists. Preview does not execute anything, and rule listing does not revalidate or hide stale rules; stale identities simply cannot match.

Permission documents are conversation scoped with `fork: initial`. Neither `sessions.ts` worker creation nor server side-question forks copy them (only the existing AutoAccept document is copied by the YOLO inheritance behavior). The originating conversation id is also checked on every matched stored rule. Saving the future rule and resolving the original once approval occur in one transaction; both original and future bindings are revalidated. The original retains its immutable separate binding and does not become a future grant unless the edited future command is identical. Repeated similar replies compare the recorded future command and do not recreate revoked rules. Revocation linearizes before the next gate admission, not as cancellation of a command already admitted. A tool diagnostic `code: permission_rule` records the granting rule id in the durable tool evidence.
