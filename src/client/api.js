// Fetch wrapper: JSON in/out, throws on non-2xx with the server's error message.
export const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    ...opts,
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
};
