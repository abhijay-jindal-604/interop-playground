/**
 * The decoded credential as a document (ADR-137): the holder's claims as form fields with serif
 * values, then the issuer, signing key and dates as one row of fields. Pure over what the inspector
 * already decoded (a JWT/SD-JWT payload with its disclosures, or a JSON-LD credential); the raw JSON
 * stays in the card's disclosure. Nothing here verifies anything.
 */
import { screenCopy } from '../copy.js';

const d = screenCopy.document;

export interface CredentialDocument {
  claims: { name: string; label: string; value: string }[];
  issuer: string | null;
  signingKey: string | null;
  issued: string | null;
  expires: string | null;
  type: string | null;
}

/** registered and structural members: shown as facts or not at all, never as holder claims */
const NOT_CLAIMS = new Set([
  'iss',
  'iat',
  'exp',
  'nbf',
  'sub',
  'jti',
  'vct',
  'vct#integrity',
  'cnf',
  '_sd',
  '_sd_alg',
  'status',
  '@context',
  'type',
  'id',
  'issuer',
  'issuanceDate',
  'expirationDate',
  'validFrom',
  'validUntil',
  'proof',
  'credentialSubject',
  'credentialStatus',
  'credentialSchema',
  'vc',
  'nonce',
  'aud',
]);

const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const FIRST = [
  'fullName',
  'name',
  'given_name',
  'family_name',
  'dateOfBirth',
  'birthdate',
  'birth_date',
  'gender',
  'email',
];
const rank = (name: string): number => {
  const i = FIRST.indexOf(name);
  return i === -1 ? FIRST.length : i;
};

/** "dateOfBirth" → "Date of birth", unless the copy names the claim */
export function claimLabel(name: string): string {
  const known = d.claims[name];
  if (known) return known;
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : name;
}

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number'))
    return v.join(', ');
  // multilingual JSON-LD values: [{ language, value }]
  if (Array.isArray(v) && v.every((x) => isRec(x) && typeof x.value === 'string'))
    return (v as { value: string }[]).map((x) => x.value).join(' / ');
  return JSON.stringify(v);
}

/** epoch seconds or an ISO date → "21 Oct 2026" (UTC) */
function day(v: unknown): string | null {
  const t = typeof v === 'number' ? v * 1000 : typeof v === 'string' ? Date.parse(v) : Number.NaN;
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Reads a credential document out of a decoded payload and its disclosures. Returns null when there
 * is no holder claim to show (an access token, a proof JWT, a request object).
 */
export function credentialDocument(
  payload: unknown,
  disclosures: readonly { name: string | null; value: unknown }[] = [],
  header: Record<string, unknown> | null = null,
): CredentialDocument | null {
  const p = isRec(payload) ? payload : {};
  const vc = isRec(p.vc) ? p.vc : p;
  const subject = isRec(vc.credentialSubject) ? vc.credentialSubject : null;
  const claims: CredentialDocument['claims'] = [];
  const seen = new Set<string>();
  const add = (name: string, value: unknown) => {
    if (seen.has(name) || NOT_CLAIMS.has(name)) return;
    const v = text(value);
    if (v === null) return;
    seen.add(name);
    claims.push({ name, label: claimLabel(name), value: v });
  };
  for (const disc of disclosures) if (disc.name) add(disc.name, disc.value);
  if (subject) for (const [k, v] of Object.entries(subject)) add(k, v);
  else for (const [k, v] of Object.entries(p)) add(k, v);
  if (claims.length === 0) return null;
  // the holder's identity reads first, like a passport data page; the rest keep their order
  claims.sort((a, b) => rank(a.name) - rank(b.name));
  const issuerOf = (v: unknown) => (isRec(v) ? text(v.id) : text(v));
  const proof = isRec(vc.proof) ? vc.proof : null;
  const key =
    (header && typeof header.kid === 'string' ? header.kid : null) ??
    (header && Array.isArray(header.x5c) ? 'x5c certificate chain' : null) ??
    (proof ? text(proof.verificationMethod) : null);
  const types = Array.isArray(vc.type) ? (vc.type as unknown[]) : [];
  return {
    claims,
    issuer: issuerOf(p.iss) ?? issuerOf(vc.issuer),
    signingKey: key,
    issued: day(p.iat) ?? day(vc.validFrom) ?? day(vc.issuanceDate),
    expires: day(p.exp) ?? day(vc.validUntil) ?? day(vc.expirationDate),
    type: text(p.vct) ?? (types.length > 0 ? text(types[types.length - 1]) : null),
  };
}

/** The document card: claims first, then the issuing facts; `children` is the raw view. */
export function DocumentCard({
  doc,
  children,
}: {
  doc: CredentialDocument;
  children?: React.ReactNode;
}) {
  return (
    <div className="doc-card" data-testid="credential-document">
      <dl className="doc-fields doc-claims" aria-label={d.holder}>
        {doc.claims.map((cl) => (
          <div key={cl.name} className="doc-field">
            <dt>{cl.label}</dt>
            <dd>{cl.value}</dd>
          </div>
        ))}
      </dl>
      <dl className="doc-fields doc-issuing">
        {doc.issuer ? (
          <div className="doc-field is-mono is-wide">
            <dt>{d.issuer}</dt>
            <dd>{doc.issuer}</dd>
          </div>
        ) : null}
        {doc.signingKey ? (
          <div className="doc-field is-mono is-wide">
            <dt>{d.signingKey}</dt>
            <dd>{doc.signingKey}</dd>
          </div>
        ) : null}
        {doc.type ? (
          <div className="doc-field is-mono">
            <dt>{d.type}</dt>
            <dd>{doc.type}</dd>
          </div>
        ) : null}
        {doc.issued ? (
          <div className="doc-field">
            <dt>{d.issued}</dt>
            <dd>{doc.issued}</dd>
          </div>
        ) : null}
        {doc.expires ? (
          <div className="doc-field">
            <dt>{d.expires}</dt>
            <dd>{doc.expires}</dd>
          </div>
        ) : null}
      </dl>
      {children ? (
        <details className="disclosure doc-raw">
          <summary>{d.raw}</summary>
          <div className="disclosure-body">{children}</div>
        </details>
      ) : null}
    </div>
  );
}
