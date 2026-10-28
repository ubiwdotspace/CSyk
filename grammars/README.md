# Grammars

`tree-sitter-dart.wasm` is built from [tree-sitter-dart](https://github.com/UserNobody14/tree-sitter-dart)
(MIT, Copyright (c) 2020-2022 UserNobody14 and others), as published on npm as `tree-sitter-dart@1.0.0`.
The `.wasm` shipped in that package predates the loader in `web-tree-sitter` 0.27, so it is rebuilt:

```sh
npm pack tree-sitter-dart@1.0.0 && tar xzf tree-sitter-dart-1.0.0.tgz
cd package && npx tree-sitter-cli@0.27.1 build --wasm -o tree-sitter-dart.wasm .
```

The TypeScript, JavaScript, Python and Go grammars come from their npm packages.
