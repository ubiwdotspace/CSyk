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
| zustand (TypeScript, small) | 100% | 100% | 100% / 100% | 100% / 96.3% | 100% | 96.7% / 91.8% |
| excalidraw (TypeScript, medium) | 100% | 100% | 100% / 100% | 100% / 93.1% | 100% | 98.3% / 96.8% |
| nest (TypeScript, large) | 100% | 100% | 99.2% / 100% | 96.7% / 87.3% | 100% | 98.4% / 96.9% |
| provider (Dart, small) | 100% | 100% | 100% / 100% | 100% / 97.7% | 100% | 70.9% / 89.2% |
| wonderous (Dart, medium) | 100% | 100% | 100% / 100% | 100% / 100% | 100% | 100% / 98.2% |
| flame (Dart, large) | 96.7% | 100% | 100% / 100% | 97.9% / 100% | 100% | 70.9% / 81.1% |
| fastapi-template (Python, small) | 100% | 100% | 100% / 100% | 100% / 100% | 100% | 100% / 91.5% |
| dispatch (Python, medium) | 100% | 100% | 100% / 100% | 100% / 95.2% | 100% | 98.8% / 83.7% |
| django (Python, large) | 96.7% | 100% | 96.7% / 96.7% | 100% / 95.4% | 100% | 99.3% / 47.2% |
| chi (Go, small) | 100% | 100% | 100% / 100% | 100% / 100% | 100% | 97.8% / 98.7% |
| pocketbase (Go, medium) | 100% | 96.7% | 100% / 100% | 96.7% / 96.7% | 100% | 95.1% / 93.4% |
| prometheus (Go, large) | 90% | 96.7% | 93.3% / 93.3% | 93.3% / 91.9% | 100% | 91.5% / 97.1% |

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

### The current version, 80 issues three times

The first 20 issues of each benchmark, run three times with CSyk and three times with Claude Code
alone, side by side (240 sessions each), with the version that reads docs and configs, answers a
missed `grep` briefly and gives a file's path once above its hits. The third run could also `read`
several symbols in one call; it read as often as the first two (0.94 reads a session), and
without the issue below its tokens fell between theirs (14.5% fewer, against 14.0% and 15.5%).
Each issue is averaged over its three runs.

| | With CSyk, against Claude Code alone |
|---|---|
| Issues where CSyk used fewer tokens | **57 of 80** (sign test p = 0.0002) |
| Tokens per issue, mean | **11.4% fewer** (95% interval: 3.5% to 17.9% fewer) |
| Tokens per issue, the median issue | 9.2% fewer |
| Turns per issue | **3.66** against 4.44 |
| Changed functions named | 1.5 points more (better on 12 issues, worse on 8) |
| First file right | 3.3 points more (better on 7, worse on 3) |
| All changed files in first five | 1.3 points fewer (better on 2, worse on 4) |

By language, the mean: JavaScript 22.3% fewer, Go 14.3% fewer, Python 8.6% fewer, TypeScript 0.8%
more. TypeScript rests on one issue, `microsoft__vscode-173585`, whose sessions ran from 6 to 29
turns in either setup: 817k tokens with CSyk against 192k without in one run, 74k against 363k in
another. Without it, each run used 14.0% to 15.5% fewer tokens.

### Issues never used to tune

Every change above was measured on the first 20 issues of each benchmark, so it may fit those
issues more than issues in general. Issues 31 to 50 of the same samples were never run before (21
to 30 were, in the 120-issue round), and the version whose `grep` gives the most complete of three
forms that fits its budget ran on them once, side by side with Claude Code alone:

| | Issues 1–20, tuned on | Issues 31–50, never seen |
|---|---|---|
| Tokens per issue, mean | 12.5% fewer (95% interval: 5.0% to 19.4% fewer) | **12.6% fewer** (5.7% to 18.8% fewer) |
| Turns per issue | 3.61 against 4.49 | **3.59** against 4.34 |
| Changed functions named | 6.9 points more | 4.1 points more |
| First file right | 3.8 points fewer | 2.5 points fewer |
| Languages with fewer tokens | all four | all four (TypeScript 7.0%, JavaScript 23.7%, Python 10.9%, Go 3.8%) |

Where CSyk's first file was wrong and Claude Code alone's right, the right file was in CSyk's
answer too, second or third, in all but one issue: the agent's ordering, not a missing file.

## Against Serena and Graphify

[Serena](https://github.com/oraios/serena) (2.1.1, commit `ede329a`) and
[Graphify](https://github.com/Graphify-Labs/graphify) (0.9.97) answered the same questions on the
same twelve repositories, through their own MCP servers, each asked the way its own tools allow:

- **Serena**, in the `claude-code` context that `serena setup claude-code` registers: `find_symbol`
  for a name (with substring matching for part of a name); for uses and callers, `find_symbol` to
  get the symbol's file and then `find_referencing_symbols`. It has no tool for what a function
  calls or for an edit's impact, and in that context it leaves text search to the agent's own Grep.
- **Graphify**, on the code graph it builds from the repository with tree-sitter (no LLM):
  `get_node` for a name (and for each candidate when the name is ambiguous, as its answer says
  to), `query_graph` for part of a name or a message, `get_neighbors` for uses, callers and calls.
  Its MCP server has no tool for an edit's impact.

Queries are passed as the questions are written, the same for every tool.

### Accuracy and tokens

Means over the twelve repositories, everything started cold.

| | **CSyk** | Serena | Graphify |
|---|---|---|---|
| Exact name: first answer right | **98.6%** | 85.1% | 79.9% |
| Part of a name: first answer right | **99.4%** | 17.0% | 31.6% |
| Uses: found / correct | **97.3% / 97.8%** | 76.5% / 81.2% | 28.6% / 41.6% |
| Callers and calls: found / correct | **98.7% / 96.1%** | 77.5% / 75.0% | 47.7% / 53.8% |
| Message: in the first five | **100%** | – | 11.9% |
| Tokens per answer | **115** | 243 | 719 |
| Tool calls per question | **1.0** | 1.5 | 1.2 |

Serena's uses and callers come from its language server like CSyk's, but its `find_symbol` takes a
name's pattern, not words, so parts of names written as words (`set state internal`) rarely
match, and the first symbol it returns for a common name is often not the one asked about.
Graphify's graph keeps one edge between two symbols, so a function that uses a name several
times shows one of those lines, and a search for a message only matches words in names.

### Time and resources on the same work

Exact names, parts of names and uses, the kinds all three answer. CPU time and peak memory are the
tool's and every process it starts (language servers, Graphify's graph build), sampled with `ps`;
for CSyk, which the harness runs in its own process, its growth over the harness's size. Measured
from cold: CSyk with an empty index cache, Serena without its symbol cache, Graphify building its
graph in the run.

| Median time per answer | a name | part of a name | uses |
|---|---|---|---|
| **CSyk** | **1 ms** | **1 ms** | **45 ms** |
| Serena | 234 ms | 212 ms | 592 ms |
| Graphify, once its graph is built | 1 ms | 19 ms | 1 ms |

| Repository | CSyk: CPU / peak memory | Serena | Graphify |
|---|---|---|---|
| zustand | **2.8 s / 533 MB** | 125 s / 1,440 MB | 8.3 s / 681 MB |
| excalidraw | **6.6 s / 822 MB** | 670 s / 3,126 MB | 31 s / 931 MB |
| nest | **23 s** / 1,290 MB | 582 s / 2,882 MB | 46 s / **918 MB** |
| provider | 16.5 s / 1,349 MB | 17.7 s / 1,108 MB | **5.8 s / 695 MB** |
| wonderous | 9.7 s / 815 MB | 23 s / 864 MB | **8.5 s / 719 MB** |
| flame | **18.5 s** / 803 MB | 183 s / 1,322 MB | 26 s / **765 MB** |
| fastapi-template | **1.3 s / 293 MB** | 12 s / 1,477 MB | 8 s / 751 MB |
| dispatch | **3.7 s / 326 MB** | 32 s / 713 MB | 31 s / 903 MB |
| django | **21 s / 959 MB** | 167 s / 2,212 MB | 105 s / 1,615 MB |
| chi | **3.4 s** / 601 MB | 9.6 s / **558 MB** | 6.1 s / 684 MB |
| pocketbase | **7.5 s / 635 MB** | 38 s / 888 MB | 38 s / 996 MB |
| prometheus | 90 s / 2,220 MB | 904 s / 1,835 MB | **39 s / 1,077 MB** |
| **All twelve: CPU / mean peak** | **205 s / 887 MB** | 2,764 s / 1,535 MB | 353 s / 895 MB |

CSyk's own process grows by about 100 MB on a large repository; the rest of its memory and almost
all its CPU is the language server it starts for uses (for Prometheus, `gopls` type-checking 256
modules: 85 of the 90 CPU seconds and 2.2 GB). Questions about names never start one.

### Why Serena and Graphify take longer

- **Serena** answers every question through its language server and its own Python layer, names
  included: 0.2 to 3 seconds per question, where CSyk answers names from its index in memory. Uses
  take two calls (the symbol's file first), and for each reference Serena then finds the symbol
  around it; on a TypeScript monorepo the language server first loads every project, over 100
  seconds for some questions on excalidraw. Its first use downloads and starts the language server
  and builds its symbol cache.
- **Graphify** answers in milliseconds because the work is done first: `graphify extract` parses
  the whole repository into a graph, and after code changes the graph has to be rebuilt
  (`graphify update`, or its git hooks after a commit); until then, answers can be out of date. Its
  answers are longer (`query_graph` returns up to about 2,000 tokens of graph), and in Claude Code
  its rules and hooks send the agent to the graph before it searches, which adds turns.
- **CSyk** parses a file in about a millisecond, saves its index, and before every answer takes in
  the files that changed; it starts a language server only for uses, callers and impact, and keeps
  it ten minutes.

### Agent sessions

The issues of [Agent sessions on real issues](#agent-sessions-on-real-issues), with each tool set
up as its own Claude Code setup installs it: Serena with the `claude-code` context and the hooks
its documentation recommends; Graphify with the rules and hooks `graphify claude install` writes
and its graph rebuilt for each issue before the session (not counted). No setup has a shell, so
Graphify's command line is reached through its MCP server. The four setups ran side by side;
peak memory and CPU are Claude Code's and every server it started.

The first ten issues of each benchmark (40 issues):

| Language | Setup | First file right | All changed files in first five | Changed functions named | Tokens per issue | Median time | Peak memory | CPU |
|---|---|---|---|---|---|---|---|---|
| TypeScript | Claude Code alone | 100% | 80% | 75.0% | 49,289 | 23.6 s | 262 MB | 1.7 s |
| | with CSyk | 90% | 80% | 62.5% | **46,689 (−5%)** | **20.2 s** | 564 MB | 8.2 s |
| | with Serena | 90% | 70% | 75.0% | 47,658 (−3%) | 25.0 s | 616 MB | 4.6 s |
| | with Graphify | 90% | 80% | 75.0% | 98,599 (+100%) | 28.0 s | 598 MB | 4.4 s |
| JavaScript | Claude Code alone | 80% | 40% | 67.5% | 55,793 | 16.4 s | 275 MB | 1.0 s |
| | with CSyk | 90% | 40% | 67.5% | 61,110 (+10%) | 19.8 s | 543 MB | 2.4 s |
| | with Serena | 80% | 50% | 70.0% | 65,378 (+17%) | 19.0 s | 665 MB | 2.8 s |
| | with Graphify | 80% | 50% | 70.0% | 77,291 (+39%) | 20.5 s | 381 MB | 1.8 s |
| Python | Claude Code alone | 90% | 80% | 67.8% | 25,096 | 13.1 s | 262 MB | 1.4 s |
| | with CSyk | 90% | 80% | 71.1% | **19,864 (−21%)** | **11.5 s** | 548 MB | 5.5 s |
| | with Serena | 90% | 80% | 67.8% | 24,437 (−3%) | 14.0 s | 530 MB | 4.2 s |
| | with Graphify | 90% | 80% | 67.8% | 44,790 (+78%) | 19.7 s | 600 MB | 3.4 s |
| Go | Claude Code alone | 90% | 70% | 59.0% | 57,036 | 20.1 s | 271 MB | 1.1 s |
| | with CSyk | 90% | 70% | 71.3% | **45,636 (−20%)** | **15.1 s** | 461 MB | 3.2 s |
| | with Serena | 90% | 70% | 67.3% | 64,090 (+12%) | 19.0 s | 768 MB | 11.3 s |
| | with Graphify | 90% | 70% | 57.3% | 66,005 (+16%) | 13.0 s | 445 MB | 1.8 s |

Over the 40 issues, against the same issues with Claude Code alone: CSyk 7.4% fewer tokens and 1.5
points more changed functions named; Serena 7.7% more tokens and 2.9 points more; Graphify 53%
more tokens and 0.2 points more. Ten issues per language is a small sample: a difference of a
few points, or JavaScript's +10% for CSyk, is within what separates two runs of the same setup.
On all 30 issues of each benchmark (120), CSyk used 8.0% fewer tokens and named 3.1 points more
changed functions; Serena used 20.1% more tokens and named 1.4 points more.

### Limits of this comparison

- Each tool is measured on what it is for here: finding code. Serena also edits and refactors, and
  Graphify also maps docs, papers and images; neither is measured.
- Answers are scored on the lines they point at. Graphify's graph keeps one edge between two
  symbols rather than every line of a use, which costs it on uses.
- Times are on one laptop (Apple silicon, 16 GB) that was also running other benchmarks; CPU time
  and memory change little with load, wall time does.

## Reproduce

A change, at a chosen size: `npm run bench -- --tier <5|10|20|30|50> [--only <tools>] [--run <name>]`
runs the single questions of the kinds those tools answer and the agent sessions on every
benchmark, the measured setup and Claude Code alone side by side, then prints both summaries. A
tier is the number of questions of each kind per repository and of issues per language; tiers
nest, so going up a tier only runs what is new. See [CONTRIBUTING.md](../CONTRIBUTING.md).

Compare only sessions run side by side. Claude Code's own context, which is most of the tokens of
every session, changes with its version and with the plugins and skills on the machine: on one
laptop, a change of setup doubled it for every setup alike. `npm run bench` therefore runs Claude
Code alone again under each `--run` name.

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
