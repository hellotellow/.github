# .github
A special repository that holds policies, templates and actions for the whole organization.



# Usage

## auto-merge.yaml
Add a new auto-merge.yaml in your repo unde .github/workflows
```
name: Auto Merge

on: pull_request_target

permissions:
  pull-requests: write
  contents: write

jobs:
  call-auto-merge:
    uses: hellotellow/.github/.github/workflows/auto-merge.yaml@main
    with:
      pr-url: ${{ github.event.pull_request.html_url }}
      repo-token: ${{ secrets.GITHUB_TOKEN }}
```
