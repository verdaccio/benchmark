# tarballs/

Drop local, **unpublished** Verdaccio builds here (`.tgz`) to benchmark them like
any other version. This folder is mounted into the Docker container at
`/app/tarballs`, so it works in every benchmark type (bench, monorepo, compare).

The tarballs themselves are gitignored (only this README is committed).

## Make a tarball

From a Verdaccio checkout, build the publishable package:

```sh
# in the verdaccio repo (the package you want to test)
npm pack            # → verdaccio-<version>.tgz
```

Copy the resulting `.tgz` into this folder.

## Use it

Reference it in `--versions` by **filename** (a spec ending in `.tgz`/`.tar.gz` is
treated as a local tarball). Its identity in the results/report is the tarball's
own version with a `+tar` suffix, so it never collides with a published version.

```sh
# normal bench, comparing a published version against your local build
pnpm docker:bench -- --versions v9=next-9,local=verdaccio-9.0.0-next.tgz --samples 5

# monorepo publish
pnpm docker:bench:monorepo -- --versions local=verdaccio-9.0.0-next.tgz --monorepo-packages 100

# throwaway comparison
pnpm bench:compare -- --versions v9=next-9,local=verdaccio-9.0.0-next.tgz --scenarios publish
```

Rebuilding a tarball with the same filename is fine — the harness re-installs it
when the file's contents change (a content hash is tracked per build).
