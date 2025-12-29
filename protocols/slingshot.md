# SLINGSHOT PROTOCOL

```
 ███████╗██╗     ██╗███╗   ██╗ ██████╗ ███████╗██╗  ██╗ ██████╗ ████████╗
 ██╔════╝██║     ██║████╗  ██║██╔════╝ ██╔════╝██║  ██║██╔═══██╗╚══██╔══╝
 ███████╗██║     ██║██╔██╗ ██║██║  ███╗███████╗███████║██║   ██║   ██║
 ╚════██║██║     ██║██║╚██╗██║██║   ██║╚════██║██╔══██║██║   ██║   ██║
 ███████║███████╗██║██║ ╚████║╚██████╔╝███████║██║  ██║╚██████╔╝   ██║
 ╚══════╝╚══════╝╚═╝╚═╝  ╚═══╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝ ╚═════╝    ╚═╝
                    Trajectory Generation Protocol
```

---

## WHEN TO INVOKE

- All current planets blocked (waiting on external dependencies)
- Planet dead (4/4 experiments exhausted, $0 revenue)
- Navigation failure (stuck >30 minutes)
- Need new vector (no obvious next step)

---

## THE SLINGSHOT PROCESS

### Phase 1: ORBIT ANALYSIS
List current constraints and available resources:
- What assets exist? (tools, websites, content)
- What skills available? (coding, analysis, automation)
- What cannot be done? (needs accounts, needs capital)

### Phase 2: VECTOR GENERATION
Generate 5 potential new planets:

| # | Planet Name | Revenue Model | Experiments Available | Constraint Check |
|---|-------------|---------------|----------------------|------------------|
| 1 | [Name] | [How it makes money] | 4 | [What's needed] |
| 2 | ... | ... | ... | ... |

### Phase 3: TRAJECTORY SCORING
Score each using the 420 scale:

- Autonomous execution possible? (+50)
- Revenue potential >$100/month? (+100)
- Can launch within 24 hours? (+50)
- Unique (not duplicate of existing)? (+100)
- Aligns with existing infrastructure? (+50)

### Phase 4: LAUNCH
Select highest scoring planet (minimum 380).

```
SELECTED PLANET: [Name]
Score: [X]/420
First Experiment: [Description]
Launch: NOW
```

---

## OUTPUT FORMAT

After SLINGSHOT, update PROJECT_STATE.md:

```markdown
## SLINGSHOT LOG
| # | Date | Trigger | Planet Created | Score | Result |
|---|------|---------|----------------|-------|--------|
| X | YYYY-MM-DD | [Why triggered] | [Planet] | [Score] | [Outcome] |
```

---

## CONSTRAINTS

- Minimum score 380 to launch
- Maximum 1 SLINGSHOT per hour (prevent thrashing)
- Log EVERY slingshot (tracking = accountability)
- Never slingshot to duplicate planet

---

## THE RULE

> **"All work exhausted is a LIE. Work is NEVER exhausted.
> If blocked, SLINGSHOT. If stuck, SLINGSHOT.
> The void has infinite planets. I just need to find them."**
