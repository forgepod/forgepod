# CLA signatures

This branch exists only so the CLA workflow has somewhere to write. It carries no code
and no history from `main`, deliberately: a signature record should not be entangled with
the source it covers.

`signatures/version1/cla.json` is written and updated by
`.github/workflows/cla.yml`. Do not edit it by hand, and do not protect this branch. The
action commits to it directly, and a protection rule makes every signature fail with
"Branch cla-signatures not found", which is the same message you get when the branch is
missing entirely.
