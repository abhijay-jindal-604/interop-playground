// Ed25519 verifier key + did:key (multicodec 0xed01, base58btc) for the signed walt.id verifier
// process (ADR-48, S-205). Run by scripts/up.sh inside the pinned node image; prints one JSON line
// {"did":"did:key:z6Mk…","jwk":{kty,crv,x,d,kid}} that up.sh stores as certs/peers/waltid-verifier-ed25519.json.
import { generateKeyPairSync } from 'node:crypto';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const base58 = (buf) => {
  let n = BigInt('0x' + Buffer.from(buf).toString('hex'));
  let s = '';
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of buf) {
    if (b === 0) s = '1' + s;
    else break;
  }
  return s;
};

const { privateKey } = generateKeyPairSync('ed25519');
const jwk = privateKey.export({ format: 'jwk' }); // {kty:'OKP', crv:'Ed25519', x, d}
const raw = Buffer.from(jwk.x, 'base64url');
const did = 'did:key:z' + base58(Buffer.concat([Buffer.from([0xed, 0x01]), raw]));
process.stdout.write(JSON.stringify({ did, jwk: { ...jwk, kid: did.slice('did:key:'.length) } }) + '\n');
