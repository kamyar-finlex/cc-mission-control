---
name: project-updates
description: Write short, non-technical project updates from the day's Claude Code sessions, using the local CC Mission Control digest (http://localhost:7777/api/digest), show every draft, and post them as Linear project updates only after the user explicitly confirms. Use when the user says "project updates", "/project-updates", "daily update", "write today's project updates", or clicks the dashboard's Project updates button. Accepts an optional range "today" (default), "yesterday" or "week".
---

# Project updates

Turn a day of Claude Code sessions into one short update per Linear project. Nothing is posted until the user says yes.

## 1. Get the digest

```bash
curl -s -H 'Host: localhost:7777' 'http://127.0.0.1:7777/api/digest?range=today'
```

Use `range=yesterday` or `range=week` if the user asked for that. If the request fails, CC Mission Control isn't running. Tell the user to start it with `npx cc-mission-control`, then stop.

The JSON has:
- `projects`: each item has `name`, an optional `url`, and its `sessions`. Each session has `title`, `story`, `recapsThatDay`, `asksThatDay`, `stillOpen`, `tickets`, `pullRequests` and `deployments`.
- `unassigned`: titles of sessions with no Linear project. These are left out on purpose.

## 2. Check the mapping

A session's project is a best guess from the tickets it mentioned. For each session, read its title, story and `recapsThatDay`. Drop the session if its work clearly isn't about that project, for example a tooling session that only mentioned a ticket in passing. Drop a project that ends up with no sessions.

## 3. Write one update per project

Base the update only on what the digest says happened that day. Don't invent progress, dates or plans. Leave out anything unclear.

**Shape:** at most 5 short lines, in this order:
- **Progress:** what moved forward that day, in one or two sentences.
- **Next:** what happens next.
- **Needs attention:** blockers, risks or decisions that are waiting. Only include this line if there are any.

**Tone:** plain language for a non-engineering reader. Write about outcomes ("the new sign-up page is ready for customers to try"), not mechanics.

**Never include:**
- code, commands, file paths, branch names, commit hashes or config keys
- internal URLs, hostnames, environment names or tool internals
- credentials, tokens, keys or anything that looks like a secret
- customer names, personal data, or people's email addresses
- the names of colleagues, unless the update needs to say who a blocker waits on

Ticket ids and release versions are fine only when a reader needs them to find something. Prefer the plain description.

Suggest a health for each project:
- `onTrack`: progress and nothing blocking
- `atRisk`: a blocker or an open decision
- `offTrack`: only if the day clearly shows it

## 4. Show the drafts and wait

Show every draft in one message, like this:

```
### <Project name>  ·  health: On track
<the update>
```

After the drafts, add one line listing the sessions that were left out: unassigned ones and dropped ones.

Then ask once, with the AskUserQuestion tool if it's available. Offer these options: post all, post some, edit first, or don't post. **Do not post anything until the user explicitly says yes.** If they want changes, revise the drafts, show them again and ask again.

## 5. Post (only after a yes)

Post each confirmed update with the Linear MCP `save_status_update` tool:
- `type`: `"project"`
- `project`: the project name exactly as given in the digest
- `body`: the update as Markdown
- `health`: the health the user confirmed

Post updates one at a time. Report each one as posted or failed. If the Linear tool isn't available, give the user the text to paste instead.
