# Contributing to CSyk

Thank you for helping. Bug reports, wrong answers found on a public repository, and pull requests
are all welcome.

For anything larger than a small fix, open an issue first and say what you want to change. CSyk's
answers are measured, so a change to what an answer contains is judged by its numbers.

## Set up

You need Node 22.18 or later (`nvm use` picks the version in `.nvmrc`) on macOS or Linux.

```sh
git clone https://github.com/ubiwdotspace/CSyk.git
cd CSyk
npm install
npm run typecheck
npm test
node src/cli.ts serve <folder>      # run from source; Node removes the types itself
```

TypeScript and Python language servers come with the dependencies. To work on Go or Dart, install
`gopls` (`go install golang.org/x/tools/gopls@latest`) or the Dart or Flutter SDK.

## Changing answers

If a change affects what a tool answers (ranking, what an answer shows, how long it is, or a tool
description), measure it before and after, and put both numbers in the pull request. `npm run
bench` measures at a chosen size, on only the tools and the language a change touches. Build and
measure a change on TypeScript and JavaScript first (`--lang ts`); once it holds there, bring it to
the other languages one at a time (`--lang py`, `go`, `dart`), rather than running all of them for
every step:

```sh
npm run corpora                                   # once: fetch the pinned public repositories
npm run bench -- --tier 5 --lang ts --only grep --run my-change
npm run bench -- --tier 10 --lang ts --only grep --run my-change   # runs only the 5 new issues
```

Tiers nest, so going up a tier reuses what ran. While optimizing, go 5, 10, 20, 30 and stop as soon
as the change is clearly worse; a release is measured at 50. The agent sessions are billed to your
Claude account (about $0.05 an issue); `--skip agents` runs only the single questions, which are
free.

`npm run gate` holds the single questions on mini-ts, zustand, parse-server, chi and provider to
`eval/gate.json`, and fails when one kind of question falls by more than a point there; run it
after the eval below, before asking for a merge. When a change moves those scores on purpose,
rerun them (with Go 1.27.0, `gopls` v0.24.0 and Flutter 3.47.3, the versions the baseline was
written with) and write the new baseline in the same pull request:

```sh
npm run corpora -- --only zustand,parse-server,chi,provider
for p in eval/corpora/provider/packages/*/; do (cd "$p" && flutter pub get); done
npm run eval -- --adapter csyk --corpus mini-ts,zustand,parse-server,chi,provider --limit 30
npm run gate -- --write
```

[docs/benchmarks.md](docs/benchmarks.md#reproduce) lists the corpora and the kinds of
question. Tool descriptions are re-read by the agent on every turn, so a longer description needs
a measured reason.

Only use public repositories as evaluation data. Private repositories go in
`eval/corpora.local.yaml` and their questions in `eval/cases/private/`; git ignores both. Never
commit code, paths or questions taken from a private repository.

## Code

- TypeScript in strict mode, ES modules. Node runs the sources directly, so use only syntax that
  can be erased (no `enum`, `namespace` or constructor parameter properties).
- Tests sit next to the code as `*.test.ts` and run with Vitest.
- Comments say why, not what.
- New third-party code or data that ships in the package goes in [NOTICE](NOTICE).

## Commits and pull requests

Commit messages start with a type (`feat`, `fix`, `eval`, `docs`, `chore`) and say what changed in
plain words, for example `fix: grep hit lines do not repeat the code shown below them`.

Nothing runs on GitHub when you push or open a pull request: this repository uses no GitHub
Actions. Run the checks on your machine before asking for a merge, and say in the pull request that
they pass:

```sh
npm run typecheck && npm test && npm run build
```

A change to answers also runs the eval and `npm run gate` (see "Changing answers"). The
maintainer reviews and checks each pull request before merging it. Keep a pull request to one
change.

`main` takes changes only through pull requests: no direct pushes, force pushes or deletion. Only
the maintainer merges; anyone can open a pull request from a branch or a fork:

```sh
git switch -c fix/short-name
git push -u origin fix/short-name
gh pr create --fill
gh pr merge --merge              # the maintainer; the branch is deleted after the merge
```

Release tags (`v*`) are created by maintainers only.

## Releasing

Maintainers release from an up-to-date, clean `main`, by hand. Bump the version on a branch and
merge it (`main` takes pull requests only), then from the merge commit:

```sh
npm run typecheck && npm test
npm publish --access public --otp=<code>        # prepack builds dist/ first
git tag v<version> && git push origin v<version>
```

The standalone packages (Node.js inside) are built with `scripts/package.sh <darwin|linux>
<arm64|x64>`, tried with `node scripts/smoke.ts packages/csyk-<os>-<arch>/bin/csyk` where they can
run, and attached to the GitHub release:

```sh
gh release create v<version> --generate-notes --verify-tag packages/*.tar.gz
```

Before 1.0, use `minor` for new features or changed answers and `patch` for fixes. The workflows in
`.github/workflows` describe the same steps; they do not run while GitHub Actions is off for this
repository.

## Licence

By contributing, you agree that your contribution is licensed under the Apache License 2.0, the
same as the rest of the project (see section 5 of [LICENSE](LICENSE)).

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
