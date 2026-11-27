# Working in this repository

This is `aws/jsii-compiler`, the `jsii` compiler. It turns TypeScript libraries into `.jsii` assemblies.

- To build and test, run `npx projen pre-compile && npx projen compile && npx projen post-compile`, then
  `npx projen test`. To run one folder, use `yarn jest test/<folder>`.
- The project is managed with projen. Change `.projenrc.ts` instead of the files it generates.
- For how we write tests and send pull requests, please read [CONTRIBUTING.md](CONTRIBUTING.md).
