# Disposable review enrollment probe

This documentation-only change provides a fresh pull request head for observing
whether the installed Devin Review integration emits its own commit status.
It changes no runtime behavior, dependencies, workflows, or repository settings.

This probe is not intended to merge. After recording the automatic review status
and addressing any findings, close the pull request without merging and remove
only its disposable remote branch.
