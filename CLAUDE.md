# Project Knowledge Base

## About this project
GTranslateV4 — real-time Romanian-to-English speech translation for live JW meetings.
Stack: Node.js/Express, Google Cloud Speech-to-Text V1, Google Cloud Translation API v3,
Socket.IO, AudioWorklet. Deployed on Koyeb (service: gtranslate, app: gtranslate).
Branch: main. NovaTranslate branch uses Deepgram instead of Google STT.

---

## Mandatory rules — no exceptions

1. **Always search the KB before doing anything** (Step 1 below)
2. **Always update the version number** in index.html h1 tag (e.g. v186) when making any change
3. **Always run `npm test`** after every change — fix any newly failing tests before proceeding
4. **Always run the `app-code-reviewer` QA agent** after every change — fix all issues found
5. **Never commit or push until tests and QA both pass**
6. **Push to `origin` (GitHub) only** — no Heroku, Koyeb auto-deploys from GitHub
7. **Always `unset KOYEB_TOKEN`** before any `koyeb` CLI command
8. **Check Koyeb logs before diagnosing any bug** — do not guess at causes first

---

## Workflow — follow this on every interaction, without being asked

### Step 1 — Search the KB before doing anything
Before answering, suggesting an approach, writing code, or making changes:

```bash
python3 .claude/kb.py search <keywords relevant to the task>
```

Read the results and act on them:

- **outcome: LEARNED** — this is established knowledge for this project. Use it.
  Don't re-derive it. Don't second-guess it. Don't ask the user to confirm it.

- **outcome: FAILED** — this approach has already been tried and failed in this project.
  Do NOT suggest it again. Tell the user "we already tried X and it failed because Y"
  and move on to a different approach.

If the KB is empty on a topic, proceed with general knowledge and note it.

### Step 2 — Save what you learn
After any non-trivial interaction, save durable knowledge. Ask yourself:
*"If I had amnesia right now, what would I wish I knew about this project?"*

**Save a learned fact (always use quoted string — unquoted | breaks in shell):**
```bash
python3 .claude/kb.py learn "topic | what is true / what works | tags"
```

**Save a failed attempt:**
```bash
python3 .claude/kb.py failed "topic | what was tried | why it failed | tags"
```

### What is worth saving

| Situation | What to save | Command |
|-----------|-------------|---------|
| Something works a specific way in this project | The fact | `learn` |
| A bug was fixed | The symptom and the fix | `learn` |
| An approach was tried and didn't work | What was tried and why it failed | `failed` |
| A suggestion was rejected by the user | What was suggested and why it was wrong | `failed` |
| A design decision was made | The choice and the reasoning | `learn` |
| A config quirk or non-obvious setting | The detail | `learn` |
| A pattern or convention specific to this project | The pattern | `learn` |

### What is NOT worth saving
- General knowledge true of all projects of this type
- Anything instantly findable in official documentation
- Temporary or session-specific context

### Topic naming
Keep topics short and specific. Good: `webpack hmr config`, `auth token expiry`,
`vault password file location`. Bad: `bug`, `issue`, `thing we discussed`.
