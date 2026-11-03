# Validate it

The language server checks each object and its queries as you type: the Problems panel fills before you save.

**Validate Workspace** runs `opentide validate` over every object, as CI does. A problem shows once, whichever of the two found it.

- Hover a problem and choose **Explain** for what the code means and how to fix it.
- **Fix all safe problems** shows the `validate --fix --dry-run` diff before it changes anything.
- Every command the extension runs is in the sidebar's **Activity** view, with the command line to copy into a terminal or CI.
