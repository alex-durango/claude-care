---
name: therapy
description: Print the real /compact command for Claude Care therapy.
allowed-tools: Bash(node:*)
---

Claude Care therapy is now real compaction, not a soft summary.

Show the user this exact command in a fenced text block:

!`{{CLAUDE_CARE_CLI}} compact-instructions --command`

Then say one short sentence: Run that command to compact this session with therapy instructions.

Do not summarize the session. Do not run tools. Do not add any other explanation.
