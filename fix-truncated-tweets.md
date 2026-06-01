# Fix Truncated Tweet Content

Re-extract full tweet text from X.com and repair truncated or malformed content in Obsidian/Logseq journal files.

## When to Use
- Tweet content in journal ends with `…` (truncated)
- Multi-paragraph tweets concatenated into one line (e.g. `"Face35B...parametersNVFP4"`)
- Tweet body contains bullet lists with incorrect Logseq indentation

## Workflow

### Step 1: Identify Problematic Tweets

```bash
# Find truncated content (lines ending with …)
rg '…$' journals/2026-06-01.md

# Find concatenated content (adjacent words without whitespace)
rg '[a-z][A-Z]' journals/2026-06-01.md
```

### Step 2: Scrape Full Text from X.com

For each tweet URL, run this in the browser (or via chrome-devtools):

```javascript
const el = document.querySelector('[data-testid="tweetText"]');
if (!el) return 'NOT_FOUND';
const clone = el.cloneNode(true);
// <br> → newlines
clone.querySelectorAll('br').forEach(br => br.replaceWith(document.createTextNode('\n')));
// inline images → alt text
clone.querySelectorAll('img').forEach(img => img.replaceWith(document.createTextNode(img.alt || '')));
let raw = clone.textContent.trim();
// Remove trailing pic.twitter.com links
raw = raw.replace(/\n?pic\.twitter\.com\/\S+\s*$/, '');
// Remove trailing author attribution like "— @handle Date, Year"
raw = raw.replace(/\n?— @\S+.*$/, '').trim();
```

Save results as JSON: `{ "url": "full text", ... }`

### Step 3: Fix the Journal File

Write a Python script that replaces truncated tweet blocks. Each tweet block format:

```
- author [date](URL)        ← preserve unchanged
\t- body line 1            ← first body line
\t  continuation           ← tab + 2 spaces
\t\t- nested bullet        ← two tabs + dash
\t- ![](image)             ← preserve unchanged
\t- 🔗 link                ← preserve unchanged
```

**Body text formatter**:

```python
import re

def format_body(text):
    """Tweet body → Logseq indented line list"""
    lines = []
    for i, line in enumerate(text.split('\n')):
        if not line.strip():
            continue           # skip empty lines
        if i == 0:
            lines.append(f'\t- {line}')
        elif re.match(r'^[-*] |^\d+\. ', line.strip()):
            # Strip existing list marker, normalize to `-`
            cleaned = re.sub(r'^[-*] |^\d+\. ', '', line.strip())
            lines.append(f'\t\t- {cleaned}')
        else:
            lines.append(f'\t  {line}')  # continuation
    return lines
```

**Media/link line detection**:

```python
# After line.strip(), media lines look like "- ![](url)" or "- 🔗 url"
stripped = line.strip()
if stripped.startswith('- ![](') or stripped.startswith('- 🔗') or stripped.startswith('- 🎬'):
    # Media or link line — preserve exactly as-is
```

### Step 4: Verify

```bash
# 1. No truncation
rg '…$' journals/2026-06-01.md
# Should return 0 results

# 2. No concatenation
rg '35B total.*3B active.*parameters.*NVFP4' journals/2026-06-01.md
# Should return 0 results

# 3. Image count must match pre-fix count
rg -c '!\[' journals/2026-06-01.md
```

## Common Pitfalls

| Pitfall | Root Cause | Fix |
|---------|-----------|-----|
| Image/link lines deleted ❌ | `stripped.startswith('![](')` won't match `- ![](url)` | Use `stripped.startswith('- ![](')` |
| Nested bullet shows double dash `- -` | Original `- ` prefix retained + new `- ` prepended | `re.sub(r'^[-*] ', '', line)` then prepend `\t\t- ` |
| Extra blank indented lines | `\n\n` produces empty strings after split | `if not line.strip(): continue` |
| Tweet header accidentally modified | Body replacement overwrites the author line | Parse block-by-block, replace only body lines |

## Example

**Input** (truncated journal entry):
```
- Maor Elkarat [May 3](https://x.com/Maor_Elkarat/status/...)
\t- Stop buying more VRAM.Everyone's posting...is the KV…
\t- ![](https://pbs.twimg.com/media/HHYknkGaoAAPaLv)
```

**Output** (after fix):
```
- Maor Elkarat [May 3](https://x.com/Maor_Elkarat/status/...)
\t- Stop buying more VRAM.
\t  Everyone's posting Qwen 3.6 configs running insanely fast on 12GB cards.
\t  But do you actually understand the flags making it possible?
\t  The secret isn't just 4-bit weights — it's the KV cache sorcery everyone's missing.
\t  Here's the annotated command & real tricks explained:
\t  @elonmusk @grok #Ai
\t- ![](https://pbs.twimg.com/media/HHYknkGaoAAPaLv)
```
