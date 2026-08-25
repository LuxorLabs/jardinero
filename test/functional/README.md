# Functional tests

These tests check that Jardinero behaves correctly seen from outside. They go in through a public entry point, send it something, and only look at what comes back out. They never reach inside a module to check how it got there. That is the job of the unit tests, which live next to the module they cover, in `src/`. If your assertion is about the return value of a function, you are writing a unit test and it does not belong here.

