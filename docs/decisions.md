# Decisions log

Dated decision checkpoints. Entries are appended in date order.

## 2026-10-13 - Decision checkpoint T-19 (was due 2026-10-12)

- 2026-10-13, RISK-01 (G-59 `cnf.jwk` knob): **diagnosis-only.** R4b-5 ran as S-152 (2026-09-28) and found that Certify hardcodes `cnf` as `{"kid": <did:jwk>}` in Java (`CertifyIssuanceServiceImpl.java:260`), so no template change can emit `cnf.jwk`. Closing G-59 needs a Certify code change. FP-02 (the G-59 fix-it re-run) ships as a fingerprint plus spec clause plus evidence S-ID, with no re-run button (T-81). The checkpoint was due 2026-10-12 and was recorded on 2026-10-13.
- 2026-10-13, RISK-35 (deadline): the Decode submission deadline is **2026-10-26**, confirmed by the user on 2026-10-06 (USER-TODO.md item 4). T-55's 2026-10-25 package is the submission, and T-96 moves to the deadline day. The checkpoint was due 2026-10-12 and was recorded on 2026-10-13.
