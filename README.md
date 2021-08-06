# Dependabot Cron Action

A GitHub Action that automatically approves and merges pull requests made by
Dependabot (or some other user). Meant to be run periodically in a cron
schedule. Works even after March 2021 changes to Dependabot PR permissions.

## Getting started

You can run this workflow e.g. once an hour:

```yaml
name: Auto-merge dependabot updates
on:
  schedule:
    - cron: '0 * * * *'
jobs:
  test:
    name: Auto-merge dependabot updates
    runs-on: ubuntu-latest
    steps:
      - uses: akheron/dependabot-cron-action@v1
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
```

## Inputs

### `token` (required)

A [GitHub token](https://docs.github.com/en/github/authenticating-to-github/keeping-your-account-and-data-secure/creating-a-personal-access-token), usually `{{ secrets.GITHUB_TOKEN }}`, with _repo_ scope.

### `auto-merge` (optional)

Which version updates to merge automatically: `major`, `minor` or `patch`.
Defaults to `minor`.

### `merge-method` (optional)

The merge method to use: `merge`, `squash` or `rebase`. Defaults to `merge`.

### `pr-author` (optional)

The user whose pull requests to merge. Defaults to `dependabot[bot]`.

### `debug` (optional)

If set to `true`, output debug logging.
