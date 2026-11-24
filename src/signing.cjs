'use strict';

// Public client default used by uu-remote-linux (8b0cec2, src/auth.rs).
const DEFAULT_SIGN_KEY = "alWiSzXZTLu3WfFnw13uBru3";

function resolveSigningKey(accounts, env = process.env) {
  const configured = typeof accounts.signingKey === 'string' ? accounts.signingKey.trim() : '';
  return env.UU_SIGN_KEY?.trim() || configured || DEFAULT_SIGN_KEY;
}

module.exports = {resolveSigningKey};
