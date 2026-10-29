# Benchmarks

Two kinds of measurement, both reproducible from this repository: single questions, scored
against each language's own compiler, and whole agent sessions on public benchmarks of real GitHub
issues.

## Single questions

Twelve public repositories, each pinned to one commit. The test questions are generated from each
language's own compiler, which also gives the right answers. There are 30 questions of each kind
per repository, fewer when a small repository has fewer.

The six kinds of question:

- **Exact name**: find the definition of a name. Scored by whether the first answer is right.
- **Part of a name**: find a definition from a few words of its name (`calc total` for
  `calculateTotal`). Scored by whether the first answer is right.
- **Uses**: find every use of a symbol. "Found" is the share of real uses in the answer; "correct"
  is the share of the answer that really are uses.
- **Callers and calls**: find who calls a function, or what it calls. Found and correct as above.
- **Message**: given an error message or other text from the code, find the function it is in,
  among the first five answers.
- **Edit impact**: after an edit to one or two functions, list those functions and their callers
  two levels up. Found and correct as above.

| Repository | Exact name | Part of a name | Uses: found / correct | Callers and calls: found / correct | Message | Edit impact: found / correct |
|---|---|---|---|---|---|---|
| zustand (TypeScript, small) | 100% | 100% | 100% / 100% | 100% / 87% | 100% | 96.7% / 91.8% |
| excalidraw (TypeScript, medium) | 100% | 100% | 100% / 100% | 100% / 85.3% | 100% | 98.3% / 96.8% |
| nest (TypeScript, large) | 100% | 100% | 99.2% / 100% | 96.7% / 84.1% | 100% | 95.8% / 96.9% |
| provider (Dart, small) | 100% | 100% | 100% / 100% | 100% / 93.2% | 100% | 70.9% / 89.2% |
| wonderous (Dart, medium) | 100% | 100% | 100% / 100% | 100% / 99.2% | 100% | 100% / 98.2% |
| flame (Dart, large) | 96.7% | 100% | 100% / 100% | 97.9% / 100% | 100% | 71.4% / 80.9% |
| fastapi-template (Python, small) | 100% | 100% | 100% / 100% | 100% / 100% | 100% | 100% / 91.5% |
| dispatch (Python, medium) | 100% | 100% | 100% / 100% | 100% / 92.7% | 100% | 98.8% / 83.7% |
| django (Python, large) | 96.7% | 100% | 96.7% / 96.7% | 100% / 92.7% | 100% | 99.3% / 47.2% |
| chi (Go, small) | 100% | 100% | 100% / 100% | 100% / 100% | 100% | 97.8% / 98.7% |
| pocketbase (Go, medium) | 100% | 96.7% | 100% / 100% | 96.7% / 96% | 100% | 94.9% / 93.4% |
| prometheus (Go, large) | 90% | 96.7% | 93.3% / 93.3% | 93.3% / 91.9% | 100% | 89.3% / 97.2% |

The comparison with text search for every repository, and the time each tool takes, are in
[BASELINES.md](BASELINES.md).

## Agent sessions on real issues

Answering single questions well is one thing; what matters in the end is whether an agent finds
the right code with fewer tokens and in less time. These benchmarks check that on real GitHub
issues. Claude Code (with the Claude Sonnet model, run from the command line without its
interface) gets the text of an issue and the repository as it was just before the fix, and must
name the files and functions that need to change, without editing anything. Its answer is
compared with the fix that was actually merged:

- **First file right**: the first file it names is one the fix changed.
- **All changed files in first five**: every file the fix changed is among the first five it names.
- **Changed functions named**: the share of the functions and methods the fix changed that it
  names.
- **Median time**: time per issue, from start to answer; the median, from the round where both
  setups ran at the same moment.
- **Tokens per issue**: everything the model read and wrote in the session, including the context
  it re-reads on every turn; the mean and the median over the 30 issues.

Two setups answer the same issues. **Claude Code alone** has its own `Read`, `Grep` and `Glob`.
**With CSyk** is Claude Code as `csyk setup` leaves it: CSyk's six tools in place of `Grep`, plus
`Read` and `Glob`, the note and the skill.

Each benchmark contributes 30 issues drawn at random from the whole dataset (a fixed seed, no
filter on difficulty). Each setup ran the same 30 issues several times, and the table shows the
average of those runs: two runs of the same setup can differ by several points. The model's
response time changes over the day, so times come from the two rounds where both setups ran at the
same moment. Measured on 2026-10-29; the CSyk runs are its last two versions, which differ only in
`grep` listing every match when they all fit. The 1,170 sessions in the table cost about $57.

| Benchmark | Language | Setup | Runs | First file right | All changed files in first five | Changed functions named | Median time, run side by side | Tokens per issue, mean | Tokens per issue, median | Issues where CSyk used fewer tokens |
|---|---|---|---|---|---|---|---|---|---|---|
| [SWE-PolyBench Verified](https://github.com/amazon-science/SWE-PolyBench) (Amazon) | TypeScript | Claude Code alone | 6 | 93.9% | 45.6% | 55.7% | 15.3 s | 69,740 | 57,950 | |
| | | with CSyk | 5 | 90.7% | 42.0% | 63.5% | 14.1 s | 69,604 (−0%) | 56,977 (−2%) | 22 of 30 |
|  | JavaScript | Claude Code alone | 5 | 84.0% | 50.0% | 57.5% | 20.2 s | 82,770 | 74,647 | |
| | | with CSyk | 4 | 85.0% | 48.3% | 57.2% | 15.5 s | 73,872 (−11%) | 64,867 (−13%) | 20 of 30 |
| [SWE-bench Verified](https://www.swebench.com) (Princeton, OpenAI) | Python | Claude Code alone | 6 | 92.8% | 85.0% | 66.6% | 11.9 s | 47,390 | 45,580 | |
| | | with CSyk | 4 | 90.8% | 86.7% | 68.0% | 10.4 s | 42,747 (−10%) | 35,488 (−22%) | 24 of 30 |
| [Multi-SWE-bench mini](https://huggingface.co/datasets/ByteDance-Seed/Multi-SWE-bench_mini) (ByteDance) | Go | Claude Code alone | 5 | 91.3% | 60.7% | 64.7% | 14.6 s | 60,814 | 55,022 | |
| | | with CSyk | 4 | 90.0% | 60.0% | 70.0% | 13.8 s | 56,004 (−8%) | 52,882 (−4%) | 21 of 30 |

Over all 120 issues, comparing each issue's average with and without CSyk (with a 95% confidence
interval from resampling the issues):

| | With CSyk, against Claude Code alone | 95% interval |
|---|---|---|
| Tokens per issue | **7.1% fewer** | 3.0% to 11.2% fewer |
| Changed functions named | **3.4 points more** | 0.9 to 6.1 points more |
| First file right | 1.4 points fewer | 3.3 fewer to 0.4 more |
| All changed files in first five | 1.1 points fewer | 3.0 fewer to 0.8 more |

What this shows:

- **Fewer tokens.** 8% to 11% fewer per issue in JavaScript, Python and Go (22% fewer on the median
  Python issue), level in TypeScript; fewer on 20 to 24 of each benchmark's 30 issues.
- **Sooner.** 0.8 to 4.7 seconds less per issue at the median, with both setups running at the
  same time.
- **More of the right functions, about the same files.** The agent names more of the functions the
  fix changed (7.8 points more in TypeScript, 5.3 in Go, 1.4 in Python, level in JavaScript). On
  files it may be slightly behind: one to two points fewer, less than one issue in 30, and within
  what separates two runs of the same setup.
- **TypeScript saves least.** Three of its issues are in VS Code, a very large repository where the
  agent sometimes searches for 10 to 30 turns. Every answer added in such a session is re-read on
  every later turn, so once a session's CSyk answers pass 3,000 tokens, CSyk keeps them short.
  Before that, those sessions made TypeScript's average 9% higher than Claude Code alone; now it
  is level.
- **Why the savings are not larger.** About 96% of an agent's tokens on these issues are Claude
  Code's own context (its instructions, the tool list, the conversation), re-read on every turn;
  what the search tools return is 1.4% to 2.4%. A tool saves tokens by saving turns, not by giving
  shorter answers. CSyk's `grep` names the function around each match and shows the code around
  matches in a few files, so the agent goes back to read the place far less often: after 43% of
  searches that showed no code, and after 19% of those that showed up to 1,000 tokens of it. Longer
  tasks, with more searching, leave more to save; these benchmarks are short (two to five turns).

Where a dataset does not list the changed functions (SWE-bench, Multi-SWE-bench), each changed
line of the fix is mapped to the function around it. Dart has no public benchmark of this kind;
its numbers are the single-question ones above.

## Reproduce

Agent sessions:

```sh
npm run loc -- --dataset <polybench|swebench|multiswebench> --language <name> --setup <b0|csyk-lean> --count 30 --seed 1
npm run loc:report
```

`b0` is Claude Code alone and `csyk-lean` is with CSyk. Each run writes its results to a file in
`eval/results/` named after the setup, dataset and language; `--run <name>` keeps repeats of the
same setup apart. Set `CSYK_LOC_DIR` to give a run its own copies of the repositories, so two
setups can run at the same time.

Single questions:

```sh
npm install
npm run corpora                              # fetch the twelve pinned repositories into eval/corpora/
npm test                                     # unit tests
npm run eval -- --adapter csyk --corpus excalidraw
npm run eval -- --adapter b0                 # every question through text search and file reads
npm run generate -- --corpus <name> --lang <ts|py|go|dart> --category <A|B|C|D|E|G>
```

In the commands and result files, the kinds of question are letters: A exact name, B part of a
name, C uses, D callers and calls, E message, G edit impact. `b0` is text search with file
reads.

- **Repositories** are listed in `eval/corpora.yaml` (`path`, `commit`, `git`); a
  question file refuses to run against any other commit. Run `go mod download` in the Go
  repositories and `flutter pub get` in the Dart ones (`packages/*` for provider) so their
  compilers can follow imports. Private repositories go in `eval/corpora.local.yaml` and their
  questions in `eval/cases/private/`; both are ignored by git.
- **Questions** live in `eval/cases/<repository>.<letter>.yaml`: an `id`, a `query`, the expected
  locations (`file`, optional `lines`) and, for callers and calls, a `direction`.
  `npm run generate` writes them from the language's own compiler. Check generated questions
  before trusting them.
- **Text search and file reads** (`eval/adapters/b0-ripgrep.ts`) stands for an agent with only
  built-in tools: it searches with ripgrep and reads the first matching file whole; for uses and
  callers, the matching lines are its answer.
- **Scores** go to `eval/results/`, which git ignores. Tokens are counted with OpenAI's
  `o200k_base` tokenizer as a stand-in for Claude's.
- **Agent tasks**: `npm run agent:tasks -- --corpus <name>` builds 20 tasks from a repository's
  questions, and `npm run agent -- --setup <b0|csyk> --corpus <name>` runs them through Claude
  Code without its interface (`claude -p`, billed to your account), recording tokens, tool calls,
  time, cost and passes.
