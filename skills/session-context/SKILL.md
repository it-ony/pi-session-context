---
name: session-context
description: "Guide for using the set_context and monitor_pipeline tools. Covers worktree, Jira ticket, GitLab/GitHub MR, custom key use cases, and monitoring CI pipeline status in the footer. Load when starting work on a task or when context tracking needs to be set up."
argument-hint: worktree path, ticket key, MR URL, or pipeline URL
---

## Overview

The `set_context` tool updates the pi footer and controls the bash working directory.
Call it as soon as you know what you are working on — do not wait until the end.

```
🌿 my-repo  feat/SDK-1234-fix-auth   📋 SDK-1234   🔀 #771   · env  staging
```

Each entry has three fields:

| field | required | description |
|-------|----------|-------------|
| `value` | yes | URL, filesystem path, or plain text. `""` clears the key. |
| `type` | no | `"dir"` or `"link"` — controls rendering (see below) |
| `icon` | no | Single emoji or character. Falls back to default icons for well-known keys. |

Keys not mentioned in a call are left unchanged.

---

## type: "dir" — Worktree

Use for filesystem paths. The extension resolves the git root, detects the branch,
and reads the remote URL so the branch becomes a clickable link.

The key named **`worktree`** additionally redirects all bash commands to that directory
for the rest of the session — no `cd` prefix needed.

```
set_context({
  context: {
    worktree: {
      value: "~/Development/worktree/my-repo/feat/SDK-1234-fix-auth",
      type: "dir",
      icon: "🌿"
    }
  }
})
```

Renders as: `🌿 my-repo  feat/SDK-1234-fix-auth` (branch is a clickable link to the remote)

Clear worktree (also resets bash CWD):
```
set_context({ context: { worktree: { value: "" } } })
```

---

## type: "link" — Jira Ticket

Pass the **full Jira issue URL**. The extension extracts the ticket key as the display label.

```
set_context({
  context: {
    ticket: {
      value: "https://myorg.atlassian.net/browse/SDK-1234",
      type: "link",
      icon: "📋"
    }
  }
})
```

Renders as: `📋 SDK-1234` (clickable, opens the issue)

---

## type: "link" — GitLab MR / GitHub PR

Pass the **full MR or PR URL**. The extension extracts the number (`#771`).

```
set_context({
  context: {
    mr: {
      value: "https://gitlab.example.com/org/repo/-/merge_requests/771",
      type: "link",
      icon: "🔀"
    }
  }
})
```

Renders as: `🔀 #771` (clickable, opens the MR/PR)

Works the same for GitHub: `/pull/42` → `#42`.

---

## No type — Plain text

Any key without a type displays as `icon  key  value`. Use for environment, status, or anything else.

```
set_context({
  context: {
    env:    { value: "staging", icon: "🌐" },
    target: { value: "develop", icon: "🎯" }
  }
})
```

Renders as: `🌐 env  staging   🎯 target  develop`

---

## Default icons

| key | default icon |
|-----|-------------|
| `worktree` | 🌿 |
| `ticket` | 📋 |
| `mr` | 🔀 |
| anything else | · |

---

## monitor_pipeline — CI Pipeline Status

Use `monitor_pipeline` after triggering a GitLab or GitHub pipeline/job. The extension
fetches the status immediately, shows a live clickable badge in the footer, and polls
automatically until the pipeline reaches a terminal state. Notifies via `ctx.ui.notify`
when done — no follow-up calls needed.

```
monitor_pipeline({
  url:              "https://gitlab.com/org/repo/-/pipelines/12345",
  label:            "deploy",
  interval_seconds: 30        // optional, default 10, min 5
})
```

**Supported URL formats:**

| Platform | Pattern |
|----------|---------|
| GitLab pipeline | `https://<host>/group/project/-/pipelines/ID` |
| GitLab job | `https://<host>/group/project/-/jobs/ID` |
| GitHub Actions run | `https://github.com/owner/repo/actions/runs/ID` |

Self-hosted GitLab is supported — any host is accepted.

**Token env vars:** `GITLAB_TOKEN` (GitLab), `GITHUB_TOKEN` (GitHub)

**Footer rendering** — one slot per monitor, icon updates automatically:

```
⏳ deploy        (pending)
🟡 deploy        (running)   ← clickable link to the pipeline URL
✅ deploy        (success)
❌ deploy        (failed)
```

**Status icons:**

| Icon | Status |
|------|--------|
| ⏳ | pending / queued |
| 🟡 | running |
| ✅ | success |
| ❌ | failed |
| ⊘ | canceled |
| ⏭ | skipped |
| ⚠️ | fetch error (auth / network) |

The label is the clickable text in the footer — keep it short and descriptive
(`deploy`, `tests`, `build`, `e2e`).

### Removing a monitor

**As the agent** — call `stop_monitor` with the label:
```
stop_monitor({ label: "deploy" })
```

**As the user** — type `/pipeline-monitors` to get an interactive list; select a monitor to remove it.

---

## Full lifecycle example

**Starting work:**
```
set_context({
  context: {
    worktree: { value: "~/Development/worktree/my-repo/feat/SDK-1234-fix-auth", type: "dir", icon: "🌿" },
    ticket:   { value: "https://myorg.atlassian.net/browse/SDK-1234", type: "link", icon: "📋" }
  }
})
```

**After opening the MR:**
```
set_context({
  context: {
    mr: { value: "https://gitlab.example.com/org/repo/-/merge_requests/771", type: "link", icon: "🔀" }
  }
})
```

**After triggering a pipeline:**
```
monitor_pipeline({
  url:   "https://gitlab.example.com/org/repo/-/pipelines/12345",
  label: "deploy"
})
```

Footer becomes: `🌿 my-repo  feat/…   📋 SDK-1234   🔀 #771   🟡 deploy`

**Done — clear everything:**
```
set_context({
  context: {
    worktree: { value: "" },
    ticket:   { value: "" },
    mr:       { value: "" }
  }
})
```
