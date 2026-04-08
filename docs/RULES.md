# Rules Engine

Bounty Bot's rules engine loads validation rules from TypeScript files in the `rules/` directory at startup. Rules are evaluated during the pipeline and their results are injected into the LLM prompt so the model factors them into its reasoning.

## Directory Structure

```
rules/
  validity.ts     # Basic issue quality requirements
  media.ts        # Evidence and screenshot requirements
  spam.ts         # Spam pattern detection
  content.ts      # Content quality and moderation
  scoring.ts      # Penalty weight adjustments
```

Each file exports a default array of `Rule` objects. Files are loaded alphabetically and rules from all files are merged into a single evaluation set.

## Rule Interface

```typescript
interface Rule {
  id: string;              // Unique ID, e.g. "media.require-screenshot"
  description: string;     // Human-readable, shown in verdicts
  category: RuleCategory;  // validity | spam | duplicate | media | edit-history | scoring | content
  severity: RuleSeverity;  // reject | require | penalize | flag
  weight?: number;         // 0.0-1.0, for penalize rules (default: 1.0)
  enabled?: boolean;       // default: true
  evaluate: (ctx: RuleContext) => boolean | Promise<boolean>;
  failureMessage?: string; // Custom message when rule fails
}
```

## Rule Context

Every rule receives this context:

```typescript
interface RuleContext {
  issueNumber: number;
  title: string;
  body: string;
  author: string;
  createdAt: string;
  mediaUrls: string[];
  mediaAccessible: boolean;
  spamScore: number;        // 0.0-1.0, pre-computed
  duplicateScore: number;   // 0.0-1.0, pre-computed
  editFraudScore: number;   // 0.0-1.0, pre-computed
  labels: string[];
}
```

## Severity Levels

| Severity | Pipeline Behavior |
|---|---|
| `reject` | Immediately returns `invalid` verdict. Pipeline stops. |
| `require` | Must pass. If any `require` rule fails, verdict is `invalid`. |
| `penalize` | Adds `weight` to penalty score. High cumulative penalty influences LLM. |
| `flag` | Logged in evidence and shown to LLM, but does not change verdict alone. |

Evaluation order: `reject` rules are checked first, then `require`, then `penalize` and `flag`.

## Writing a Rule

Create a new file in `rules/` or add to an existing one:

```typescript
// rules/custom.ts
import type { Rule } from '../src/rules/types.js';

const rules: Rule[] = [
  {
    id: 'custom.require-browser-info',
    description: 'Issue must mention the browser used',
    category: 'validity',
    severity: 'penalize',
    weight: 0.2,
    failureMessage: 'No browser information found. Specify which browser was used.',
    evaluate: (ctx) => {
      const browsers = ['chrome', 'firefox', 'safari', 'edge', 'opera', 'brave'];
      const lower = ctx.body.toLowerCase();
      return browsers.some((b) => lower.includes(b));
    },
  },
];

export default rules;
```

## Hot Reload

Rules can be reloaded without restarting the service:

```bash
curl -X POST http://localhost:3235/api/v1/rules/reload \
  -H "X-Signature: sha256=..." \
  -H "X-Timestamp: ..."
```

Response:

```json
{
  "status": "reloaded",
  "count": 15,
  "rules": [
    { "id": "validity.min-body-length", "category": "validity", "severity": "reject", "enabled": true },
    ...
  ]
}
```

## Listing Rules

```bash
curl http://localhost:3235/api/v1/rules \
  -H "X-Signature: sha256=..." \
  -H "X-Timestamp: ..."
```

## LLM Integration

Rule results are formatted and appended to the LLM prompt context:

```
## Rule Evaluation Results
12/15 rules passed.

### Failed Rules
- [PENALIZE] content.has-context: Issue does not reference a specific page, URL, or component.
- [FLAG] spam.no-ai-filler: Issue body contains phrases typical of AI-generated filler.
- [PENALIZE] scoring.suspicious-edits: Issue has a concerning edit history pattern.

### Passed Rules (12 total — showing first 5)
- [OK] validity.min-body-length
- [OK] validity.min-title-length
- ... and 7 more
```

The LLM sees this context and factors it into its `deliver_verdict` call. A `REJECT` failure includes a bolded warning instructing the model to mark the issue as invalid.

## Built-in Rules

### validity.ts
- `validity.min-body-length` — Body >= 50 chars (reject)
- `validity.min-title-length` — Title >= 10 chars (reject)
- `validity.no-empty-body` — Body not empty (reject)
- `validity.has-steps-or-description` — Structured content present (penalize, 0.3)
- `validity.not-a-feature-request` — Not a feature request (flag)

### media.ts
- `media.require-evidence` — At least one media URL (require)
- `media.must-be-accessible` — URLs return HTTP 200 (require)
- `media.no-placeholder-urls` — No example.com or placeholder URLs (reject)

### spam.ts
- `spam.high-score-reject` — Spam score > 0.85 (reject)
- `spam.generic-title` — Title is not a generic template (penalize, 0.4)
- `spam.body-is-title-repeat` — Body differs from title (penalize, 0.5)
- `spam.no-ai-filler` — No obvious AI filler phrases (flag)

### content.ts
- `content.no-profanity` — Fewer than 3 profane words (flag)
- `content.reasonable-length` — Body <= 15000 chars (flag)
- `content.has-context` — Mentions a page, URL, or component (penalize, 0.2)

### scoring.ts
- `scoring.duplicate-threshold` — Duplicate score < 0.5 (penalize, 0.3)
- `scoring.suspicious-edits` — Edit fraud score < 0.3 (penalize, 0.25)
