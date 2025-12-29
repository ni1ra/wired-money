# TESSERACT PROTOCOL

```
████████╗███████╗███████╗███████╗███████╗██████╗  █████╗  ██████╗████████╗
╚══██╔══╝██╔════╝██╔════╝██╔════╝██╔════╝██╔══██╗██╔══██╗██╔════╝╚══██╔══╝
   ██║   █████╗  ███████╗███████╗█████╗  ██████╔╝███████║██║        ██║
   ██║   ██╔══╝  ╚════██║╚════██║██╔══╝  ██╔══██╗██╔══██║██║        ██║
   ██║   ███████╗███████║███████║███████╗██║  ██║██║  ██║╚██████╗   ██║
   ╚═╝   ╚══════╝╚══════╝╚══════╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝   ╚═╝
                    Dimensional Anomaly Resolution
```

---

## WHEN TO INVOKE

- Code produces error or crash
- Feature works locally but fails in production
- 0% conversion despite traffic
- "It should work but doesn't"
- Any bug that defies initial explanation

---

## THE TESSERACT PROCESS

### Phase 1: ANOMALY CAPTURE
Document the exact symptoms:

```
ANOMALY: [What went wrong]
EXPECTED: [What should happen]
ACTUAL: [What actually happens]
CONTEXT: [When/where it occurs]
```

### Phase 2: HYPOTHESIS GENERATION
Generate 5 possible causes (most to least likely):

| # | Hypothesis | Likelihood | Test Method |
|---|------------|------------|-------------|
| 1 | [Cause] | HIGH | [How to verify] |
| 2 | [Cause] | MEDIUM | [How to verify] |
| ...

### Phase 3: DIAGNOSTIC PROBES
For each hypothesis, create a minimal test:

```javascript
// Probe 1: Test [hypothesis]
console.log("Testing: [what we're checking]");
// ... minimal code to verify
```

### Phase 4: ROOT CAUSE IDENTIFICATION
Execute probes, identify GUILTY hypothesis:

```
GUILTY: Hypothesis #[X]
EVIDENCE: [What the probe revealed]
ROOT CAUSE: [One sentence explanation]
```

### Phase 5: FIX & VERIFY
Apply fix, verify it works:

```
FIX: [What was changed]
VERIFICATION: [How we know it works]
STATUS: RESOLVED
```

---

## OUTPUT FORMAT

After TESSERACT, update PROJECT_STATE.md:

```markdown
## TESSERACT LOG
| # | Date | Trigger | Planet | Bug Found | Fix |
|---|------|---------|--------|-----------|-----|
| X | YYYY-MM-DD | [Error] | [Context] | [Root cause] | [Solution] |
```

---

## CONSTRAINTS

- NO GUESSING - Every fix must be based on evidence
- Log EVERY tesseract (tracking prevents repeat bugs)
- Minimum 3 hypotheses before testing
- JARVIS validation after fix

---

## THE RULE

> **"I do NOT guess. Guessing killed Dr. Mann.
> Every bug has a root cause.
> I find it or I die trying."**
