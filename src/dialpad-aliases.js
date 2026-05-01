/**
 * Opaque alias tokens for Dialpad caller-ID phone numbers.
 *
 * The LinkedIn extension picks a caller ID from /dialpad-user-context, but we
 * never want raw E.164 numbers travelling through the extension. Instead the
 * worker hands back a signed JWT containing the number, and the extension
 * echoes it back on /dialpad-call where the worker decodes it server-side.
 *
 * Format: HS256 JWT with audience "dialpad-caller-id" and a 7d expiry. The
 * audience claim domain-separates these tokens from anything else signed with
 * the same secret (e.g. our other webhook JWTs), so a token minted for one
 * purpose can never be replayed against another.
 *
 * Why HS256 over the same LINKEDIN_EXTENSION_SECRET that the extension uses
 * for its own auth: it's the existing per-deployment shared secret and the
 * extension never sees raw numbers — the alias payload is tamper-proof, and
 * even if someone base64-decodes the body to read the number, that number was
 * one of the consultant's own numbers fetched seconds earlier from Dialpad
 * (it's not a secret to them). No new secret to provision.
 */
import { SignJWT, jwtVerify } from 'jose';

const ALIAS_AUDIENCE = 'dialpad-caller-id';
const ALIAS_TTL = '7d';

function getKey(env) {
  if (!env?.LINKEDIN_EXTENSION_SECRET) {
    throw new Error('LINKEDIN_EXTENSION_SECRET is required to sign dialpad aliases');
  }
  return new TextEncoder().encode(env.LINKEDIN_EXTENSION_SECRET);
}

/**
 * Mint an opaque alias for an E.164 phone number. Returns a string the
 * extension can echo back to /dialpad-call to dial that number.
 *
 * @param {string} number — E.164 phone number, e.g. "+14155551212"
 * @param {Object} env — worker env (must include LINKEDIN_EXTENSION_SECRET)
 * @returns {Promise<string>}
 */
export async function signCallerIdAlias(number, env) {
  if (typeof number !== 'string' || !number.startsWith('+')) {
    throw new Error(`signCallerIdAlias: invalid E.164 number: ${number}`);
  }
  return await new SignJWT({ n: number })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setAudience(ALIAS_AUDIENCE)
    .setExpirationTime(ALIAS_TTL)
    .sign(getKey(env));
}

/**
 * Decode an alias back to its underlying E.164 number, or null if the token is
 * missing, malformed, expired, tampered, or signed for a different audience.
 *
 * @param {unknown} alias
 * @param {Object} env
 * @returns {Promise<string|null>}
 */
export async function verifyCallerIdAlias(alias, env) {
  if (typeof alias !== 'string' || alias.length === 0) return null;
  try {
    const { payload } = await jwtVerify(alias, getKey(env), {
      algorithms: ['HS256'],
      audience: ALIAS_AUDIENCE,
    });
    return typeof payload.n === 'string' ? payload.n : null;
  } catch {
    return null;
  }
}
