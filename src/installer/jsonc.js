// Remove JSONC comments and trailing commas only outside quoted strings.
export function parseJsonc(raw) {
  let withoutComments = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (inString) {
      withoutComments += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      withoutComments += char;
    } else if (char === '/' && raw[i + 1] === '/') {
      withoutComments += ' ';
      i += 2;
      while (i < raw.length && raw[i] !== '\n' && raw[i] !== '\r') i++;
      if (i < raw.length) withoutComments += raw[i];
    } else if (char === '/' && raw[i + 1] === '*') {
      withoutComments += ' ';
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) {
        if (raw[i] === '\n' || raw[i] === '\r') withoutComments += raw[i];
        i++;
      }
      if (i === raw.length) throw new SyntaxError('Unterminated JSONC comment');
      i++;
    } else {
      withoutComments += char;
    }
  }

  let withoutTrailingCommas = '';
  inString = false;
  escaped = false;
  for (let i = 0; i < withoutComments.length; i++) {
    const char = withoutComments[i];
    if (inString) {
      withoutTrailingCommas += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      withoutTrailingCommas += char;
    } else if (char === ',') {
      let next = i + 1;
      while (/\s/.test(withoutComments[next] || '') && next < withoutComments.length) next++;
      if (withoutComments[next] !== '}' && withoutComments[next] !== ']') withoutTrailingCommas += char;
    } else {
      withoutTrailingCommas += char;
    }
  }

  return JSON.parse(withoutTrailingCommas);
}
