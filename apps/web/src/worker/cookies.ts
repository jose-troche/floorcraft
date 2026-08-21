const CLIENT_ID_COOKIE = "fc_client_id";

export function readClientId(request: Request): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(new RegExp(`${CLIENT_ID_COOKIE}=([^;]+)`));
  return match ? match[1]! : null;
}

export function setClientIdCookie(headers: Headers, clientId: string): void {
  headers.append(
    "set-cookie",
    `${CLIENT_ID_COOKIE}=${clientId}; Path=/; Max-Age=31536000; SameSite=Lax; Secure; HttpOnly`,
  );
}
