# Create your first detection

A detection in opentide is three objects that point at each other:

- a **threat** describes what an attacker does, with its ATT&CK techniques;
- an **objective** says what you want to detect about it;
- a **rule** is the query that detects it, per platform.

**New Rule…** runs `opentide new rule`, opens the file it wrote and puts the cursor on the first placeholder. **Next Placeholder** (<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>.</kbd>, also on macOS) moves to the next one and **Previous Placeholder** (<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>,</kbd>) back; `Tab` keeps indenting.

The Catalogue in the opentide sidebar shows the new rule under its objective as soon as you save.
