const clean = (value) => String(value ?? "").trim();

export function remoteMcpReady(form) {
  if (!clean(form?.name) || !clean(form?.url)) return false;
  return form?.authMode !== "bearer" || Boolean(clean(form?.bearerToken));
}

export function buildRemoteMcpConnectInput(form) {
  const headers = form?.authMode === "bearer"
    ? { Authorization: `Bearer ${clean(form?.bearerToken)}` }
    : {};
  return {
    name: clean(form?.name),
    url: clean(form?.url),
    headers,
  };
}
