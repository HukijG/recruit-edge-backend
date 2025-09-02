// auth.js - JWT verification and authentication utilities

/**
 * Verify JWT signature from Dialpad webhook
 * @param {string} token - JWT token from webhook body
 * @param {string} secret - Shared secret for verification
 * @returns {Object|null} Decoded payload or null if invalid
 */
export async function verifyJWT(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      console.error('Invalid JWT format');
      return null;
    }

    const [headerB64, payloadB64, signatureB64] = parts;
    
    // Decode header and payload
    const header = JSON.parse(atob(headerB64.replace(/-/g, '+').replace(/_/g, '/')));
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
    
    // Verify algorithm
    if (header.alg !== 'HS256') {
      console.error('Unsupported JWT algorithm:', header.alg);
      return null;
    }

    // Create signature
    const data = headerB64 + '.' + payloadB64;
    const expectedSignature = await createHMACSignature(data, secret);
    
    // Compare signatures (constant-time comparison)
    if (!constantTimeCompare(signatureB64, expectedSignature)) {
      console.error('JWT signature verification failed');
      return null;
    }

    // Check expiration if present
    if (payload.exp && Date.now() / 1000 > payload.exp) {
      console.error('JWT token expired');
      return null;
    }

    return payload;

  } catch (error) {
    console.error('JWT verification error:', error);
    return null;
  }
}

/**
 * Create HMAC-SHA256 signature
 * @param {string} data - Data to sign
 * @param {string} secret - Secret key
 * @returns {string} Base64URL encoded signature
 */
async function createHMACSignature(data, secret) {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const messageData = encoder.encode(data);
  
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
  const signatureArray = new Uint8Array(signature);
  
  // Convert to base64url
  return btoa(String.fromCharCode(...signatureArray))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Constant-time string comparison to prevent timing attacks
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {boolean} True if strings are equal
 */
function constantTimeCompare(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  
  return result === 0;
}