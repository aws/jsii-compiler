# jsii/common

jsii has some features that other packages might need to depend on, without needing the whole of jsii.

This submodule is addressing this need by exporting *small, self-contained* functions.s

Anything in here MUST NOT depend on any other code in jsii.
It SHOULD be kept very lightweight and mostly depend on TypeScript and Node built-ins.
