# Grammars

`tree-sitter-dart.wasm` is built from [tree-sitter-dart](https://github.com/UserNobody14/tree-sitter-dart)
(MIT, Copyright (c) 2020-2023 UserNobody14 and others) at commit `0038280b774b65c1b89ba7fec50624d8baed9fe1`
(October 2026), which parses Dart 3.13: class modifiers, records, patterns, extension types and
primary constructors. The npm release (1.0.0) predates both those and the loader in
`web-tree-sitter` 0.27. To rebuild it:

```sh
git init tree-sitter-dart && cd tree-sitter-dart
git fetch --depth 1 https://github.com/UserNobody14/tree-sitter-dart.git 0038280b774b65c1b89ba7fec50624d8baed9fe1
git checkout FETCH_HEAD
npx tree-sitter-cli@0.27.1 build --wasm -o tree-sitter-dart.wasm .
```

The other grammars are copied as published on npm, where each package also builds native
bindings when it is installed; CSyk loads only the WebAssembly, so it ships these files instead and
installs nothing native for them. All MIT, from https://github.com/tree-sitter:

| File | Package | Copyright |
|---|---|---|
| `tree-sitter-typescript.wasm`, `tree-sitter-tsx.wasm` | tree-sitter-typescript 0.23.2 | (c) 2017 Max Brunsfeld |
| `tree-sitter-javascript.wasm` | tree-sitter-javascript 0.25.0 | (c) 2014 Max Brunsfeld |
| `tree-sitter-python.wasm` | tree-sitter-python 0.25.0 | (c) 2016 Max Brunsfeld |
| `tree-sitter-go.wasm` | tree-sitter-go 0.25.0 | (c) 2014 Max Brunsfeld |

To update one, take the file from the package's new release (`npm pack tree-sitter-go@<version>`
and extract it), check it loads with this repository's `web-tree-sitter`, and run the tests and the
gate.
