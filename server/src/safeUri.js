// Keep database credentials out of logs and error messages.

/**
 * A connection string that is safe to print: protocol, host(s) and path only.
 * The user name, password and query string (which can carry credentials too)
 * are never included.
 */
export function safeUri(uri) {
  const m = String(uri ?? '').match(/^([a-z][a-z0-9+.-]*:\/\/)(?:[^@/?#]*@)?([^/?#]*)([^?#]*)/i);
  return m ? `${m[1]}${m[2]}${m[3]}` : '(not a valid connection string)';
}

const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

// Error messages from the driver can quote the connection string. Remove the
// credentials from any URL in the text, and the password itself wherever it appears.
export function redactSecrets(text, uri = process.env.MONGODB_URI) {
  let out = String(text ?? '').replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/?#]*@/gi, '$1***@');
  const password = String(uri ?? '').match(/^[a-z][a-z0-9+.-]*:\/\/[^:@/]*:([^@/]+)@/i)?.[1];
  if (password) {
    for (const form of new Set([password, decode(password)])) if (form.length >= 3) out = out.split(form).join('***');
  }
  return out;
}
