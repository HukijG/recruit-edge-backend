import { jwtVerify } from 'jose';

/**
 * Verify JWT signature from Dialpad webhook
 * @param {string} token 
 * @param {string} secret 
 * @returns {Object|null}
 */
export async function verifyJWT(token, secret) {
  try {
    const secretKey = new TextEncoder().encode(secret);

    const { payload, protectedHeader } = await jwtVerify(token, secretKey, {
      algorithms: ['HS256'], // explicitly allow only HS256
    });

    return payload;
  } catch (error) {
    console.error({ source: 'auth', message: 'JWT verification failed', error: error.message });
    return null;
  }
}
