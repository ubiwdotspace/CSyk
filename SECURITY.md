# Security

## Reporting a vulnerability

Report it privately through
[GitHub private vulnerability reporting](https://github.com/ubiwdotspace/CSyk/security/advisories/new).
Do not open a public issue. We aim to reply within a week.

## Supported versions

CSyk is before 1.0. Only the latest release gets fixes.

## What CSyk does on your machine

CSyk sends nothing over the network. It:

- reads the files in the folder it serves and writes its index to `~/.cache/csyk`;
- runs `git` and ripgrep, and starts the language servers for the project (TypeScript, pyright,
  `gopls`, the Dart analysis server);
- runs as Claude Code hooks on tool calls, if `csyk setup` installed them.

Reports we especially want: a tool that reads or reveals files outside the served folder, a file
name or query that changes the arguments of a command CSyk runs, and a hook that can be made to
allow or block a call it should not.
