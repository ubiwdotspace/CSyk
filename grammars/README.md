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

The TypeScript, JavaScript, Python and Go grammars come from their npm packages.
