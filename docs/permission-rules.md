# Remembered command permissions

With YOLO off, an approval offers **Allow once**, **Allow similar…**, and **Deny**. YOLO remains a separate choice to delegate all tool approvals for that conversation.

**Allow similar…** asks Kiln to preview a remembered rule before saving it. The preview includes the actual argument list, canonical working directory, executable path, and execution policy. The command field starts with the pending command. You can edit the future exact command within Kiln's supported grammar; the preview shows what will be remembered. The original pending command is displayed separately and approved once. Cancel changes nothing. Saving atomically remembers the previewed rule and approves that original call.

## Deliberately narrow support

The first policy supports explicitly verified Linux local execution without a managed scope-shell wrapper. macOS, Windows, custom execution environments, and Linux hosts using managed scopes retain one-time approval; Kiln explains the unsupported policy instead of bypassing host accounting.

Supported commands:

- `pwd`, optionally `-P`.
- `ls`, with literal paths and only `-a`, `-l`, `-la`, `-al`, or `-1` options.
- `wc`, with literal paths and only `-l`, `-w`, or `-c` options.

Arguments must match exactly. Only the restricted ASCII bare-token grammar shown by Kiln is accepted; no wildcards, prefixes, quotes, tabs, newlines, shell operators, substitutions, redirections, pipelines, environment assignments, wrappers, interpreters, Git groups, or build/test runners are remembered. For example, `bun test` can execute arbitrary project code and always needs another approval. Unsupported commands and older hosts retain **Allow once** and **Deny**.

Remembered commands run directly, without a shell, with a fixed clean environment plus Kiln's conversation attribution and managed temporary-folder variables, and a maximum duration of 30 seconds. Kiln checks the trusted system executable's canonical path, ownership, ancestry, file identity, and digest. It also binds the working directory's canonical identity. A replacement executable or directory cannot silently reuse the old rule. The existing coding-tool approval gates also apply to nested calls from codemode; a rule never approves the containing script as a whole. This feature does not expand those gates to unrelated MCP or administrative tools.

These rules are **not a filesystem sandbox or a claim that a command is safe**. Literal absolute paths and parent-relative paths can name files outside the working directory. Project contents can change between calls. The rule records permission to repeat the displayed invocation, not permission for a whole class of commands.

## Scope and revocation

Every rule belongs to one conversation and one resolved working directory. Nothing is automatically shared across the project, forked conversations, or workers. A changed working directory must be approved again. Rules persist on Kiln across restarts; Ember is not the enforcement boundary.

The conversation header's **Rules** control shows the count and saved policies even when no approval is waiting. Revoke one rule or **Clear all** to restore prompts for future calls. Revocation cannot cancel a call already admitted or running. Retrying a completed save does not recreate a revoked rule.

Autoallowed calls retain a diagnostic naming the originating rule. Existing Allow once and YOLO execution behavior is unchanged.

The authenticated wire contract is documented in [`packages/kiln/docs/permission-rules-contract.md`](../packages/kiln/docs/permission-rules-contract.md).
