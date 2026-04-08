# Rules Engine

Bounty Bot has two distinct rule systems that work together:

| Type | Directory | Execution | Purpose |
|---|---|---|---|
| **Code Rules** | `rules/code/` | Run by the engine at pipeline time | Programmatic pass/fail checks |
| **LLM Rules** | `rules/llm/` | Injected into the LLM system prompt | Natural-language instructions for the model |

Both are loaded at startup and can be hot-reloaded via `POST /api/v1/rules/reload`.

```
rules/
  code/                   # Deterministic, code-verified checks
    validity.ts           # Body length, title quality, structure
    media.ts              # Evidence requirements
    spam.ts               # Template detection, generic titles
    content.ts            # Profanity, length, context
    scoring.ts            # Penalty weight adjustments
  llm/                    # Instructions the LLM must follow
    evaluation.ts         # Evidence priority, reproducibility
    tone.ts               # Professional tone, no sympathy
    spam-detection.ts     # Template farming, AI filler
    output-format.ts      # Tool usage, reasoning structure
```

---

## Code Rules (`rules/code/`)

Code rules are TypeScript functions that evaluate an issue context and return `true` (pass) or `false` (fail). They execute deterministically in the pipeline **before** the LLM gate.

### Interface

```typescript
interface CodeRule {
  id: string;              // e.g. "code.media.require-screenshot"
  description: string;     // Human-readable, shown in verdicts
  category: RuleCategory;  // validity | spam | duplicate | media | edit-history | scoring | content
  severity: RuleSeverity;  // reject | require | penalize | flag
  weight?: number;         // 0.0-1.0, for penalize rules (default: 1.0)
  enabled?: boolean;       // default: true
  evaluate: (ctx: RuleContext) => boolean | Promise<boolean>;
  failureMessage?: string;
}
```

### Severity Levels

| Severity | Pipeline Behavior |
|---|---|
| `reject` | Immediately returns `invalid`. Pipeline stops. |
| `require` | Must pass. Any failure = `invalid`. |
| `penalize` | Adds `weight` to cumulative penalty score. |
| `flag` | Logged and visible to LLM, but no verdict change alone. |

### Writing a Code Rule

```typescript
// rules/code/custom.ts
import type { Rule } from '../../src/rules/types.js';

const rules: Rule[] = [
  {
    id: 'code.custom.require-browser',
    description: 'Issue must mention the browser used',
    category: 'validity',
    severity: 'penalize',
    weight: 0.2,
    failureMessage: 'No browser information found.',
    evaluate: (ctx) => {
      const browsers = ['chrome', 'firefox', 'safari', 'edge'];
      return browsers.some((b) => ctx.body.toLowerCase().includes(b));
    },
  },
];

export default rules;
```

### Rule Context

```typescript
interface RuleContext {
  issueNumber: number;
  title: string;
  body: string;
  author: string;
  createdAt: string;
  mediaUrls: string[];
  mediaAccessible: boolean;
  spamScore: number;        // 0.0-1.0
  duplicateScore: number;   // 0.0-1.0
  editFraudScore: number;   // 0.0-1.0
  labels: string[];
}
```

---

## LLM Rules (`rules/llm/`)

LLM rules are natural-language instructions injected into the model's system prompt. They tell the LLM **how to reason**, **what to prioritize**, and **how to format its output**. They don't execute code — they shape the model's behavior.

### Interface

```typescript
interface LLMRule {
  id: string;              // e.g. "llm.eval.evidence-first"
  description: string;     // Short label for logs
  category: string;        // evaluation | tone | spam | output-format | ...
  priority: LLMRulePriority; // critical | high | normal | low
  enabled?: boolean;       // default: true
  instruction: string;     // The actual text injected into the prompt
  condition?: (ctx: RuleContext) => boolean; // Optional: only inject when true
}
```

### Priority Ordering

Instructions are injected in priority order — `critical` first, `low` last:

| Priority | When to use |
|---|---|
| `critical` | Core evaluation criteria that must never be violated |
| `high` | Important constraints (confidence calibration, duplicate rules) |
| `normal` | Tone and formatting preferences |
| `low` | Nice-to-have guidelines |

### Conditional Rules

LLM rules can have a `condition` function. The instruction is only injected when the condition returns `true`:

```typescript
{
  id: 'llm.spam.burst-awareness',
  description: 'Extra scrutiny for high spam scores',
  category: 'spam',
  priority: 'normal',
  instruction: 'The pre-computed spam score is high. Pay extra attention to quality.',
  condition: (ctx) => ctx.spamScore > 0.5,
}
```

### Writing an LLM Rule

```typescript
// rules/llm/custom.ts
import type { LLMRule } from '../../src/rules/types.js';

const rules: LLMRule[] = [
  {
    id: 'llm.custom.platform-specific',
    description: 'Platform-specific evaluation context',
    category: 'evaluation',
    priority: 'normal',
    instruction:
      'This bounty program is for a web application. Mobile-only bugs reported ' +
      'without specifying the responsive viewport are still VALID if the screenshots ' +
      'clearly show the issue in a browser.',
  },
];

export default rules;
```

---

## How They Work Together

```
Pipeline execution:
  1. Media check          → pass/fail
  2. Spam detection       → score
  3. Duplicate detection  → score
  4. Edit history         → score
  5. Code rules evaluated → reject/require/penalize/flag results
  6. LLM gate receives:
     a. The issue content
     b. Code rule results (pass/fail report)
     c. LLM rule instructions (numbered list)
     → LLM calls deliver_verdict
```

The LLM prompt includes both:

```
## Code Rule Results
12/15 programmatic checks passed.

### Failed Checks
- [PENALIZE] code.content.has-context: No page/URL reference found.

## Evaluation Instructions
You MUST follow these rules when making your verdict:

1. Always prioritize concrete evidence over narrative quality...
2. A valid bug report must contain enough information for reproduction...
3. Never soften a verdict out of sympathy...
```

---

## Hot Reload

```bash
curl -X POST http://localhost:3235/api/v1/rules/reload \
  -H "X-Signature: sha256=..." -H "X-Timestamp: ..."
```

Both code and LLM rules are reloaded from disk.

---

## Built-in Code Rules

### `rules/code/validity.ts`
| ID | Severity | Description |
|---|---|---|
| `validity.min-body-length` | reject | Body >= 50 chars |
| `validity.min-title-length` | reject | Title >= 10 chars |
| `validity.no-empty-body` | reject | Body not empty |
| `validity.has-steps-or-description` | penalize (0.3) | Structured content |
| `validity.not-a-feature-request` | flag | Not a feature request |

### `rules/code/media.ts`
| ID | Severity | Description |
|---|---|---|
| `media.require-evidence` | require | At least one media URL |
| `media.must-be-accessible` | require | URLs return HTTP 200 |
| `media.no-placeholder-urls` | reject | No example.com URLs |

### `rules/code/spam.ts`
| ID | Severity | Description |
|---|---|---|
| `spam.high-score-reject` | reject | Spam score > 0.85 |
| `spam.generic-title` | penalize (0.4) | Not a generic template |
| `spam.body-is-title-repeat` | penalize (0.5) | Body differs from title |
| `spam.no-ai-filler` | flag | No AI filler phrases |

### `rules/code/content.ts`
| ID | Severity | Description |
|---|---|---|
| `content.no-profanity` | flag | < 3 profane words |
| `content.reasonable-length` | flag | Body <= 15000 chars |
| `content.has-context` | penalize (0.2) | References page/URL/component |

### `rules/code/scoring.ts`
| ID | Severity | Description |
|---|---|---|
| `scoring.duplicate-threshold` | penalize (0.3) | Dup score < 0.5 |
| `scoring.suspicious-edits` | penalize (0.25) | Fraud score < 0.3 |

---

## Built-in LLM Rules

### `rules/llm/evaluation.ts`
| ID | Priority | Instruction summary |
|---|---|---|
| `llm.eval.evidence-first` | critical | Prioritize evidence over narrative |
| `llm.eval.reproducibility` | critical | Require reproducibility path |
| `llm.eval.older-wins` | high | Older issue takes precedence |
| `llm.eval.confidence-calibration` | high | Calibrate confidence scores |
| `llm.eval.no-benefit-of-doubt` | high | No benefit of the doubt |

### `rules/llm/tone.ts`
| ID | Priority | Instruction summary |
|---|---|---|
| `llm.tone.professional` | normal | Neutral, factual tone |
| `llm.tone.no-sympathy` | high | No sympathy verdicts |
| `llm.tone.concise-recap` | normal | 2-3 sentence recap |

### `rules/llm/spam-detection.ts`
| ID | Priority | Instruction summary |
|---|---|---|
| `llm.spam.template-farming` | critical | Detect template-farmed content |
| `llm.spam.ai-generated` | high | Detect AI filler |
| `llm.spam.screenshot-mismatch` | high | Check screenshot/description match |
| `llm.spam.burst-awareness` | normal | Extra scrutiny when spam > 0.5 (conditional) |

### `rules/llm/output-format.ts`
| ID | Priority | Instruction summary |
|---|---|---|
| `llm.format.must-call-tool` | critical | Must call deliver_verdict |
| `llm.format.reasoning-before-verdict` | high | Reasoning before conclusion |
| `llm.format.no-internal-details` | high | No internal details in recap |
